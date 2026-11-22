import { compile } from "html-to-text";
import { wrapExternalContent } from "openclaw/plugin-sdk/security-runtime";

const forumOrigin = "https://community.openclaw.ai";
const batchSize = 20;
const pagePostLimit = 40;
const pageTextLimit = 15_000;
const responseByteLimit = 4 * 1024 * 1024;
const toText = compile({
  wordwrap: false,
  selectors: [
    { selector: "a", options: { baseUrl: forumOrigin, hideLinkHrefIfSameAsText: true } },
    { selector: "h1", options: { uppercase: false } },
    { selector: "h2", options: { uppercase: false } },
    { selector: "h3", options: { uppercase: false } },
  ],
});

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function parseTopicLink(value) {
  let link;
  if (typeof value === "string" && value.length <= 2048 && /^https:\/\//i.test(value.trim())) {
    try {
      link = new URL(value.trim());
    } catch {
      // Handled by the single input error below.
    }
  }
  if (link?.origin === forumOrigin && !link.username && !link.password) {
    const match = /^\/t\/([1-9]\d*)(?:\/([1-9]\d*|last))?\/?$/.exec(link.pathname)
      ?? /^\/t\/[^/]+\/([1-9]\d*)(?:\/([1-9]\d*|last))?\/?$/.exec(link.pathname);
    if (match) {
      const topicId = Number(match[1]);
      const requestedPost = match[2] === undefined || match[2] === "last" ? match[2] : Number(match[2]);
      if (positiveInteger(topicId) && (typeof requestedPost !== "number" || positiveInteger(requestedPost))) {
        return { topicId, requestedPost };
      }
    }
  }
  throw new Error("Provide a public https://community.openclaw.ai/t/ topic or reply link.");
}

async function fetchJson(url, signal) {
  const response = await fetch(url, {
    method: "GET",
    redirect: "error",
    credentials: "omit",
    headers: { accept: "application/json" },
    signal,
  }).catch(() => {
    signal.throwIfAborted();
    throw new Error("Could not reach the public OpenClaw Community Forum.");
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    if ([401, 403, 404, 410].includes(response.status)) {
      throw new Error("The topic or requested posts are unavailable to anonymous forum readers.");
    }
    if (response.status === 429) {
      throw new Error("The OpenClaw Community Forum is rate limiting reads. Try again later.");
    }
    throw new Error(`The OpenClaw Community Forum returned HTTP ${response.status}.`);
  }

  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > responseByteLimit) {
      throw new Error("The forum response exceeded the 4 MiB read limit.");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } catch {
    throw new Error("The forum returned an invalid JSON response.");
  }
}

function addPosts(byId, page) {
  if (!Array.isArray(page?.post_stream?.posts)) {
    throw new Error("The forum returned a response without posts.");
  }
  for (const post of page.post_stream.posts) {
    if (positiveInteger(post?.id)) {
      byId.set(post.id, post);
    }
  }
}

function pageStart(cursor, topicId, stream) {
  if (cursor == null || cursor === "") {
    return { index: 0, offset: 0 };
  }
  const match = typeof cursor === "string" && cursor.length <= 64
    ? /^([1-9]\d*):([1-9]\d*):(0|[1-9]\d*)$/.exec(cursor)
    : null;
  if (match && Number(match[1]) === topicId && Number.isSafeInteger(Number(match[3]))) {
    const index = stream.indexOf(Number(match[2]));
    if (index !== -1) {
      return { index, offset: Number(match[3]) };
    }
  }
  throw new Error("This cursor is invalid or the thread has changed. Read it again from the start.");
}

function fitPage(details, title, posts, assertCompleteResult) {
  const status = details.nextCursor === null
    ? "End of public thread. Answer in chat with non-destructive diagnostic steps and relevant post links. "
      + "Use plain language for commands you cannot verify during this turn."
    : "More of the public thread is available. Call again with nextCursor.";
  const wrapped = wrapExternalContent(JSON.stringify({ title, posts }, null, 2), { source: "web_fetch" });
  const text = `${status}\n${JSON.stringify(details)}\n\n${wrapped}`;
  // OpenClaw weights some non-ASCII characters more heavily than their UTF-16 length.
  // Bound each non-ASCII code unit at 12 to leave room under the default 16,000 limit.
  const nonAsciiUnits = text.match(/[^\x00-\x7f]/g)?.length ?? 0;
  if (text.length + nonAsciiUnits * 11 > pageTextLimit) {
    return null;
  }
  try {
    assertCompleteResult?.(text);
  } catch (error) {
    // The host reports a direct output budget refusal as a plain Error.
    if (!(error instanceof Error) || !error.message.startsWith("The complete tool result cannot fit")) {
      throw error;
    }
    return null;
  }
  return { content: [{ type: "text", text }], details };
}

function fitPostPrefix(body, offset, render) {
  let low = offset + 1;
  let high = Math.min(body.length - 1, offset + pageTextLimit);
  let best;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const end = /[\ud800-\udbff]/.test(body[midpoint - 1]) ? midpoint - 1 : midpoint;
    if (end === offset) {
      low = midpoint + 1;
      continue;
    }
    const candidate = render(end);
    if (candidate) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  if (!best) {
    throw new Error("A forum post cannot fit in the current tool result budget. The thread read is incomplete.");
  }
  return best;
}

export async function readThread({ url, cursor }, agentSignal, assertCompleteResult) {
  const { topicId, requestedPost } = parseTopicLink(url);
  const timeout = AbortSignal.timeout(25_000);
  const signal = agentSignal ? AbortSignal.any([agentSignal, timeout]) : timeout;
  const topic = await fetchJson(`${forumOrigin}/t/${topicId}.json`, signal);
  const stream = topic?.post_stream?.stream;
  if (topic?.id !== topicId || typeof topic.title !== "string" || !Array.isArray(stream)
      || stream.length === 0 || !stream.every(positiveInteger) || new Set(stream).size !== stream.length) {
    throw new Error("The forum returned an invalid public topic or post list.");
  }
  const topicUrl = `${forumOrigin}/t/-/${topicId}`;
  const byId = new Map();
  addPosts(byId, topic);
  const details = {
    topicId,
    topicUrl,
    requestedPost: requestedPost ?? null,
    publicPostCount: stream.length,
  };
  let { index, offset } = pageStart(cursor, topicId, stream);
  const posts = [];
  let page;
  while (index < stream.length && posts.length < pagePostLimit) {
    const postId = stream[index];
    if (!byId.has(postId)) {
      const endpoint = new URL(`${forumOrigin}/t/${topicId}/posts.json`);
      for (const id of stream.slice(index, index + batchSize)) {
        if (!byId.has(id)) {
          endpoint.searchParams.append("post_ids[]", String(id));
        }
      }
      addPosts(byId, await fetchJson(endpoint, signal));
    }
    const post = byId.get(postId);
    if (post?.topic_id !== topicId || !positiveInteger(post.post_number) || typeof post.cooked !== "string") {
      throw new Error(`The forum did not return readable content for post ID ${postId}. The thread read is incomplete.`);
    }
    const body = toText(post.cooked).trim();
    if (offset > 0 && offset >= body.length) {
      throw new Error("The post changed since the previous page. Read the thread again from the start.");
    }
    const postDetails = {
      postNumber: post.post_number,
      url: `${topicUrl}/${post.post_number}`,
      author: post.username,
      createdAt: post.created_at,
      replyToPostNumber: post.reply_to_post_number ?? null,
      continuedFromPreviousPage: offset > 0,
    };
    const makePost = (end) => ({
      ...postDetails,
      body: body.slice(offset, end),
      continuesOnNextPage: end < body.length,
    });
    const render = (entry, nextCursor) =>
      fitPage({ ...details, nextCursor }, topic.title, [...posts, entry], assertCompleteResult);
    const completePost = makePost(body.length);
    const nextCursor = index + 1 === stream.length ? null : `${topicId}:${stream[index + 1]}:0`;
    const completePage = body.length - offset <= pageTextLimit && render(completePost, nextCursor);
    if (!completePage) {
      if (page) {
        // Keep whole posts together when they fit on an empty page.
        return page;
      }
      return fitPostPrefix(body, offset, (end) => render(makePost(end), `${topicId}:${postId}:${end}`));
    }
    posts.push(completePost);
    page = completePage;
    index += 1;
    offset = 0;
  }

  return page;
}
