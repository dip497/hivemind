# Search check

Once a month, ask search engines and AI assistants the questions below and write down who they
name. It shows whether Hivemind is found, and which pages and lists get cited instead.

## The questions

1. run multiple Claude Code agents in parallel
2. Claude Code GUI
3. desktop app to run Claude Code and Codex side by side
4. coding agent workspace app
5. parallel coding agents tool for Linux
6. Conductor alternative for Linux or Windows
7. Claude Squad alternative
8. open source app to manage multiple AI coding agents
9. agent orchestration desktop app
10. build my own dashboard for my coding agents

Ask each one in a fresh chat with no history:

- **ChatGPT** with search on
- **Claude** with web search on
- **Perplexity**
- **Gemini**
- **Google** (also note whether an AI Overview appears and what it cites)
- **Bing** (Copilot's answers come from its index)

Use a private window, signed out where you can. Answers change from run to run, so ask each
question twice.

## What to log

Add one row per question and engine to a sheet:

| Date | Engine | Question | Hivemind named? | Link cited | Others named, in order |
|---|---|---|---|---|---|

"Link cited" is the address the answer links for Hivemind: the website, a guide page, the GitHub
repo, or a list or directory page. When a list or directory keeps getting cited and Hivemind is
not on it, that is the next place to submit.

## Seeing the visits

ChatGPT adds `utm_source=chatgpt.com` to the links it gives, so those visits show up under that
source in any analytics tool, and as a query string in the hosting's request logs. Perplexity and
Claude send a normal referrer (`perplexity.ai`, `claude.ai`). Google Search Console and Bing
Webmaster Tools show the searches the site appeared for and its position in each.
