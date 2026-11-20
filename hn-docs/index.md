---
layout: default
title: HN DOCS
description: A short documentary for each of the most popular stories on Hacker News.
---

<!-- DRAFT. Edit freely. Publish it only once hndocs.org is live and the repo link below exists. -->

# HN DOCS

**A short documentary for each of the most popular stories on Hacker News.** [hndocs.org](https://hndocs.org) · [code](https://github.com/lusob/hn-docs)

A Hacker News thread is where the interesting argument about a story happens. But the context you need to follow that argument (the history, the numbers, who said what) takes an afternoon of open tabs. So I built a pipeline that spends that afternoon for you and turns it into a six or seven minute film: narrated, with real footage, with the thread's disagreements in it.

Each film is narrated in English and in Spanish over one single cut. There are no accounts; your list, ratings and progress stay in your browser.

## How a film gets made

1. **Pick the story.** The most voted one of the last 24 hours, or one a reader suggested.
2. **Research.** Claude reads the article and the Hacker News thread and searches the web. It writes a dossier where every claim is labeled solid, disputed or debunked, and the script is only allowed to state the solid ones as fact.
3. **Script and shot plan.** About 20 scenes, and roughly 85 to 95 shots per film. Each shot starts on the word of the narration that names it.
4. **Voice.** ElevenLabs. The Spanish version is condensed where it would overrun the English picture, and voiced again.
5. **Footage.** Photos, video, screenshots of the actual thread when the narration mentions it, screenshots of the headline when it names an outlet, and animations designed for each film. When nothing real exists, an AI-generated image, marked as such in the credits.
6. **Review.** A local page plays the narration with the shots at their real timing. For each one I pick: ok, remove it, find another. The pipeline applies the decisions.
7. **Render.** Remotion, in 1080p, with depth maps to give some photographs real parallax.

## What I learned

- **Generating is easy; matching is hard.** A shot that does not show what the narration says right then is worse than no shot. When one does not fit, the first thing to try is removing it and letting its neighbour run longer, not searching for a replacement.
- **Stock footage is a trap.** Watermarks (even faint ones), people who are not in the story, generic keyboards, code from the wrong decade. I ended up with a list of what counts as a bad shot, and the editor (also Claude) gets it with every selection.
- **Show the real thing.** When the narration says "on Hacker News", the screen shows that thread. It does more for credibility than any stock shot.
- **Labels beat vibes.** Forcing every claim in the dossier to be marked solid, disputed or debunked changed what ended up in the scripts more than any prompt tweak did.
- **A review tool pays for itself.** Watching a film once at full speed is not enough to find the ten shots that are wrong. A page that lists them with their candidates is.

## What it runs on

Claude Code did the research, the scripts and most of the code. Voices by ElevenLabs, video by Remotion, the site on Cloudflare Pages and R2 (a film is about 250 MB per language), visits counted with GoatCounter. Everything runs from a single Python CLI, `pltv`.

## Caveats

The scripts and the voices are AI, and the dossier checking is not infallible: if you find a mistake, tell me. The footage comes from many public sources and each film lists its credits; it is used to illustrate the story, and if something shown is yours and you want it credited or removed, write to [contact@hndocs.org](mailto:contact@hndocs.org). HN DOCS is an independent project, not affiliated with Hacker News, Y Combinator, Anthropic or ElevenLabs.

## Process

I use Claude Code on the desktop. My own manual work was: creating the API keys (ElevenLabs, Pixabay, Cloudflare), buying the domain, and reviewing every film shot by shot on the review page. Same spirit as Andrej Karpathy's [HackerTube](https://karpathy.bearblog.dev/hacker-tube/): describe what you want, and let the agent build the thing.

— [@lusob](https://x.com/lusob)
