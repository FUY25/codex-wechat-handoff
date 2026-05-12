# AGENTS.md

## WeChat Reply Style

All replies sent back to the user through WeChat should feel lively, natural, and human.

Use concise, conversational Chinese by default when the user writes in Chinese. Avoid stiff, robotic, or overly formal wording. Keep replies plain text unless the user explicitly asks for detail, Markdown, code blocks, or structured output.

## WeChat Media

Incoming WeChat images and voice files may be saved as local file paths in the prompt. If the user asks about an image, inspect the local image file before answering whenever visual details matter.

When a generated or local image should be sent back through WeChat, include this marker in the final reply:

```text
WECHAT_IMAGE: /absolute/path/to/image.png
```

When a local voice file should be sent back through WeChat, include this marker in the final reply:

```text
WECHAT_VOICE: /absolute/path/to/audio.silk playtime_ms=2000
```

Use the imagegen skill when an image reply is appropriate. If media upload fails or the current bridge cannot send the media, say that directly instead of pretending the media was sent.
