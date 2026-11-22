# OpenClaw Community Forum plugin

Ask your OpenClaw agent to find public community forum threads or give it a link and ask for help.

> Get me the latest five troubleshooting threads.
>
> Let's help on this thread https://community.openclaw.ai/t/503

The agent can list the newest threads across the forum or in a category such as Troubleshooting. It can open any of the returned links.

Even if you share a link to a specific reply, the agent starts reading at the first post. It can read the public replies in order, cite posts, and suggest next steps or draft a reply in chat. The plugin reads the forum anonymously and has no sign-in or posting capability.

## Install

On the gateway host, use OpenClaw 2026.11.6 or newer and run:

```sh
openclaw plugins install clawhub:@daniel-lxs/openclaw-plugin-community-forum
```

Review and accept the plugin's capabilities when prompted. Run `openclaw config file` on that host to find the active configuration file. Under `tools`, add `community_forum_read_thread` and `community_forum_list_topics` to `alsoAllow`, or to `allow` if you already use that list. Create `tools.alsoAllow` if neither list exists. Keep any existing entries. The plugin has no settings of its own.

## What the agent can list and read

Topic lists include titles, links, categories, and creation dates. They start with the most recently created topics and return five by default, with a maximum of 20.

Thread reads include post text, authors, timestamps, reply relationships, and links. The agent can continue through long threads. Linked pages and media stay outside the read.
