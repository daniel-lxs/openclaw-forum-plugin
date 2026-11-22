import { compile } from "html-to-text";

const forumOrigin = "https://community.openclaw.ai";
const batchSize = 20;
const pagePostLimit = 40;
const pageBodyLimit = 16_000;
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

export async function readThread({ url, cursor }, agentSignal) {
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
  let { index, offset } = pageStart(cursor, topicId, stream);
  const posts = [];
  let remaining = pageBodyLimit;
  while (index < stream.length && posts.length < pagePostLimit && remaining > 0) {
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
    let end = Math.min(offset + remaining, body.length);
    if (end < body.length && /[\ud800-\udbff]/.test(body[end - 1])) {
      end -= 1;
    }
    if (end === offset && end < body.length) {
      break;
    }
    posts.push({
      postNumber: post.post_number,
      url: `${topicUrl}/${post.post_number}`,
      author: post.username,
      createdAt: post.created_at,
      replyToPostNumber: post.reply_to_post_number ?? null,
      continuedFromPreviousPage: offset > 0,
      continuesOnNextPage: end < body.length,
      body: body.slice(offset, end),
    });
    remaining -= end - offset;
    if (end < body.length) {
      offset = end;
      break;
    }
    index += 1;
    offset = 0;
  }

  return {
    topicId,
    topicUrl,
    title: topic.title,
    requestedPost: requestedPost ?? null,
    publicPostCount: stream.length,
    nextCursor: index === stream.length ? null : `${topicId}:${stream[index]}:${offset}`,
    posts,
  };
}
