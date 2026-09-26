# Changelog

## 0.4.1

The README and the package description now lead with what the package does: your agent asks, your user taps Approve or Deny on their phone. No code changes.

## 0.4.0

**Customer approvals and questions for Mastra agents.**

Require approval before protected tools execute, or suspend a confirm, choice or text question until the customer answers. The native Pushary app is the primary review surface.

Persist Mastra runs and the application review mapping to resume after a process restart. Bind the customer and exact draft version, preserve returned output, and refuse duplicate or mismatched resumes.

Requires the shared Pushary SDK 2.1. Finish existing pending operations on their original SDK version before upgrading. The adapter is MIT-licensed; real phone delivery uses the hosted Partner service.

[Run or adapt the example](https://github.com/Pushary/pushary-mastra/blob/main/examples/README.md).
