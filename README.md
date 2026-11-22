# OpenClaw Community Forum plugin

Give your OpenClaw agent a public community forum link and ask for help in chat.

> Let's help on this thread https://community.openclaw.ai/t/503

Even if you share a link to a specific reply, the agent starts reading at the first post. It can read the public replies in order, cite posts, and suggest next steps or draft a reply in chat. The plugin reads the forum anonymously and has no sign-in or posting capability.

## Install

On the gateway host, use OpenClaw 2026.11.6 or newer and run:

```sh
openclaw plugins install clawhub:@daniel-lxs/openclaw-plugin-community-forum
```

Review and accept the plugin's capabilities when prompted. Run `openclaw config file` on that host to find the active configuration file. Under `tools`, add `community_forum_read_thread` to `alsoAllow`, or to `allow` if you already use that list. Create `tools.alsoAllow` if neither list exists. Keep any existing entries. The plugin has no settings of its own.

## What the agent can read

The tool returns post text, authors, timestamps, reply relationships, and links. It follows the public view of the topic at the time of the read and can continue through long threads. Linked pages and media stay outside the read.
