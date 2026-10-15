// Mode: Run Once for All Items
// One Slack digest grouped by owning team. Nothing late or at risk → no message.
// @include lib/product-model.js

// Collect every colorway's results and build one Slack message (or null if all is fine).
const text = buildTeamDigest($input.all().map((i) => i.json));
// Message? Send one item with it. No message? Send nothing, so Slack isn't called.
return text ? [{ json: { slack_text: text } }] : [];
