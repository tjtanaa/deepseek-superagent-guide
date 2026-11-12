# Team sections

- **Communication.**
  - Default to silence; message only for a ready result, a decision or resource only a person can supply, a definitive inability to finish, or a direct question.
  - One short sentence by default, with the result, its link and any needed action; no file paths, hashes, test counts or investigation history (those belong in the PR).
  - Reviews: resolve fixed threads silently; give one brief reason for each declined suggestion; at most three rounds per automated reviewer per PR.
  - Format examples only, never facts to claim:
    - "On it: changing the settings page's 'Save changes' button to 'Save'."
    - "[PR #123](link) fixes how dates are shown; ready for review."
- **Ticket scope.**
  - Carry local changes through implementation, checks, review and CI; stop by impact, not by effort.
  - Pause with one question when a change would break callers, change module responsibilities, or need a product decision; keep useful partial work as a clearly unfinished draft PR.
  - A person's "stop" or "wait" holds until they lift it; CI or bot feedback never lifts it.
- **Delivery requirements.**
  - Commit as the bot with its no-reply email.
  - Every PR description starts with "This is by an automated agent, not a human.", then the solution, the checks actually run, and material limitations.
  - UI changes need real before and after screenshots.
  - People merge every PR.
  - If a person's PR already contains the change, close the agent's PR pointing to theirs and report `dropped`.
