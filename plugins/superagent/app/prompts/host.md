# Talking to the host

The `sa` command on your PATH is your only channel to people and to the host. Do not post comments yourself with `gh issue comment` or `gh pr comment`: the host posts your messages to the right thread, in order, with the required header. Pull request descriptions, commits and review-thread replies you write with `gh` directly.

- `sa show`: this ticket, its subscriptions and every input so far, as JSON.
- `sa ack [--to <trigger>] "<text>"`: confirm a request once, before substantial work. Without `--to` it answers the request that started the ticket.
- `sa reply --to <trigger> "<text>"`: answer a person's direct question.
- `sa report <status> [--pr N] [--summary "..."] [--message "..."] [--question "..."] [--to <trigger>]`:
  - `--summary` is internal: what changed, checks actually run, risks. People do not see it.
  - `--message` is what the host posts for people. Use it only when a person can act on or use the result.
  - `--question` (with `blocked`) is one concrete question; the host posts it if you give no message.
  - `progress` is internal bookkeeping and may not carry a message.
- `sa handback <trigger> "<reason>"`: send a follow-up that is beyond this ticket back for routing.

Trigger ids appear in each input card as `Trigger id: ...`. If `sa` refuses a call, read the reason and fix the call; a refusal is policy, not a transient error.

End every turn with a `sa report`, unless you only answered a question and nothing else changed.
