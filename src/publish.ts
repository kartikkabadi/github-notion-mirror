import { getOctokit } from "./github/auth.ts";
import { getNotion, notionCall } from "./notion/client.ts";
import { requireDataSourceId, ensureOption } from "./notion/schema.ts";
import { logger } from "./logging.ts";
import { nowIso } from "./util.ts";

// W1: Notion → GitHub issue creation.
// Explicit opt-in: user sets Publish State = "ready" on a Notion Work Items row.
// Daemon creates the GitHub issue and writes back Number, URL, Node ID, etc.

type NotionWorkItemPage = {
  page_id: string;
  title: string;
  body_markdown: string | null;
  repo_full_name: string | null;
  repo_notion_page_id: string | null;
  labels: string[];
  publish_state: string | null;
  origin: string | null;
};

export async function pollReadyIssues(): Promise<{ created: number; errors: number }> {
  const workDsId = requireDataSourceId("work_items");
  const notion = getNotion();

  // Query for Publish State = "ready"
  const res = await notionCall(() =>
    notion.dataSources.query({
      data_source_id: workDsId,
      filter: {
        property: "Publish State",
        select: { equals: "ready" },
      },
      page_size: 20,
    }),
  );

  if (res.results.length === 0) {
    return { created: 0, errors: 0 };
  }

  logger.info({ count: res.results.length }, "found ready issues to publish");

  let created = 0;
  let errors = 0;

  for (const page of res.results) {
    try {
      await publishOneIssue(page.id, workDsId);
      created++;
    } catch (err) {
      logger.error({ page_id: page.id, err: (err as Error).message }, "publish failed");
      errors++;
      // Mark as error in Notion
      await markPublishError(page.id, (err as Error).message);
    }
  }

  return { created, errors };
}

async function publishOneIssue(pageId: string, workDsId: string): Promise<void> {
  const notion = getNotion();

  // Fetch full page to read properties
  const page = await notionCall(() => notion.pages.retrieve({ page_id: pageId }));
  const props = (page as { properties: Record<string, unknown> }).properties;

  // Extract title
  const titleProp = props["Title"] as { title?: { plain_text?: string }[] } | undefined;
  const title = titleProp?.title?.[0]?.plain_text ?? "";
  if (!title) throw new Error("No title set on Notion work item");

  // Extract repository relation → look up repo full name
  const repoProp = props["Repository"] as { relation?: { id: string }[] } | undefined;
  const repoPageId = repoProp?.relation?.[0]?.id;
  if (!repoPageId) throw new Error("No repository relation set on Notion work item");

  // Fetch repo page to get Full Name
  const repoPage = await notionCall(() => notion.pages.retrieve({ page_id: repoPageId }));
  const repoProps = (repoPage as { properties: Record<string, unknown> }).properties;
  const fullNameProp = repoProps["Full Name"] as { rich_text?: { plain_text?: string }[] } | undefined;
  const repoFullName = fullNameProp?.rich_text?.[0]?.plain_text ?? "";
  if (!repoFullName) throw new Error("Could not determine repository full name from relation");

  // Extract labels
  const labelsProp = props["Labels"] as { multi_select?: { name: string }[] } | undefined;
  const labels = labelsProp?.multi_select?.map((l) => l.name) ?? [];

  // Extract body from page content (markdown)
  // ponytail: Notion API doesn't directly return markdown. We read the page blocks and convert.
  // For v1, we use the page's raw text blocks as the issue body.
  const bodyMarkdown = await extractPageMarkdown(pageId);

  // Mark as "creating" to prevent duplicate creates
  await notionCall(() =>
    notion.pages.update({
      page_id: pageId,
      properties: { "Publish State": { select: { name: "creating" } } } as never,
    }),
  );

  // Create GitHub issue
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) throw new Error(`bad repo full name: ${repoFullName}`);

  const ok = getOctokit();
  const created = await ok.rest.issues.create({
    owner,
    repo,
    title,
    body: bodyMarkdown || "_No body provided._",
    labels,
  });

  const issueNumber = created.data.number;
  const issueUrl = created.data.html_url;
  const issueNodeId = created.data.node_id;

  // Write back to Notion: Number, URL, Node ID, State, Origin, Publish State
  await ensureOption(workDsId, "State", "open", "select");
  await ensureOption(workDsId, "Origin", "notion", "select");

  await notionCall(() =>
    notion.pages.update({
      page_id: pageId,
      properties: {
        Number: { number: issueNumber },
        "GitHub URL": { url: issueUrl },
        "GitHub Node ID": { rich_text: [{ text: { content: issueNodeId } }] },
        State: { select: { name: "open" } },
        Type: { select: { name: "Issue" } },
        Origin: { select: { name: "notion" } },
        "Publish State": { select: { name: "created" } },
        "Publish Error": { rich_text: [] },
        "Last Synced": { date: { start: nowIso() } },
      } as never,
    }),
  );

  logger.info({ page_id: pageId, repo: repoFullName, issue_number: issueNumber, url: issueUrl }, "issue created from Notion");
}

async function markPublishError(pageId: string, errorMsg: string): Promise<void> {
  const notion = getNotion();
  try {
    await notionCall(() =>
      notion.pages.update({
        page_id: pageId,
        properties: {
          "Publish State": { select: { name: "error" } },
          "Publish Error": { rich_text: [{ text: { content: errorMsg.slice(0, 2000) } }] },
        } as never,
      }),
    );
  } catch {
    // best effort
  }
}

// ponytail: extract page content as markdown by reading blocks.
// Ceiling: use Notion's markdown API when available for round-trip fidelity.
async function extractPageMarkdown(pageId: string): Promise<string> {
  const notion = getNotion();
  const blocks = await notionCall(() =>
    notion.blocks.children.list({ block_id: pageId, page_size: 100 }),
  );

  const lines: string[] = [];
  for (const block of blocks.results) {
    const b = block as { type: string; [key: string]: unknown };
    const type = b.type;
    if (type === "paragraph") {
      const richTexts = (b.paragraph as { rich_text?: { plain_text?: string }[] })?.rich_text;
      const text = richTexts?.map((rt) => rt.plain_text ?? "").join("") ?? "";
      lines.push(text);
      lines.push("");
    } else if (type === "heading_1") {
      const richTexts = (b.heading_1 as { rich_text?: { plain_text?: string }[] })?.rich_text;
      lines.push(`# ${richTexts?.map((rt) => rt.plain_text ?? "").join("") ?? ""}`);
      lines.push("");
    } else if (type === "heading_2") {
      const richTexts = (b.heading_2 as { rich_text?: { plain_text?: string }[] })?.rich_text;
      lines.push(`## ${richTexts?.map((rt) => rt.plain_text ?? "").join("") ?? ""}`);
      lines.push("");
    } else if (type === "heading_3") {
      const richTexts = (b.heading_3 as { rich_text?: { plain_text?: string }[] })?.rich_text;
      lines.push(`### ${richTexts?.map((rt) => rt.plain_text ?? "").join("") ?? ""}`);
      lines.push("");
    } else if (type === "bulleted_list_item") {
      const richTexts = (b.bulleted_list_item as { rich_text?: { plain_text?: string }[] })?.rich_text;
      lines.push(`- ${richTexts?.map((rt) => rt.plain_text ?? "").join("") ?? ""}`);
    } else if (type === "numbered_list_item") {
      const richTexts = (b.numbered_list_item as { rich_text?: { plain_text?: string }[] })?.rich_text;
      lines.push(`1. ${richTexts?.map((rt) => rt.plain_text ?? "").join("") ?? ""}`);
    } else if (type === "code") {
      const richTexts = (b.code as { rich_text?: { plain_text?: string }[]; language?: string })?.rich_text;
      const lang = (b.code as { language?: string })?.language ?? "";
      lines.push(`\`\`\`${lang}`);
      lines.push(richTexts?.map((rt) => rt.plain_text ?? "").join("") ?? "");
      lines.push("```");
      lines.push("");
    } else if (type === "quote") {
      const richTexts = (b.quote as { rich_text?: { plain_text?: string }[] })?.rich_text;
      lines.push(`> ${richTexts?.map((rt) => rt.plain_text ?? "").join("") ?? ""}`);
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}
