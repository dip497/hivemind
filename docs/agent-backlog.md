# Agent backlog

Real slowdowns not worth a fix yet. One seen again moves up to a fix.

- 2026-10-20: the laptop disk filled to 100% mid-round and stopped every agent's build (27 GB
  of film renders and Remotion bundles in the session scratchpad and `/tmp`). Seen at 96% in an
  earlier session too. Candidate fix: check `df /` before starting heavy agents, and delete your
  own scratch output when its job ends.
