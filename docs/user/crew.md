# Crew

Open **Project crew** from project navigation or the command palette, or use `/crew` or `/swarm` in a project conversation. Choose a conversation and **Use this thread** to make it the coordinator. You can open coordinator and worker chats and return to the selected initiative. Web, desktop, and mobile share the board on the connected environment.

Choose **Start now** for a swarm when the outcome is clear and work can begin immediately. Choose **Require plan approval** when you want the coordinator to first refine a brief and milestones. Workers cannot start until you approve the brief. You can also require approval for an existing initiative; its tasks and history stay available while workers stop for planning.

The coordinator uses the team tools to create tasks, assign workers, and collect results. Roles name responsibilities and optionally select a provider and model; otherwise a worker inherits the coordinator's model. Workers use separate worktrees by default. T3 reports an unavailable model or failed worktree setup instead of silently choosing another.

Tasks have acceptance criteria, dependencies, and optional milestones. Open a worker to inspect its conversation and changes. A submission identifies an exact commit or file digest and needs independent review. Requested changes require a new submission and fresh approval; an earlier approval cannot accept the replacement. Verify the combined result before accepting a milestone. Execution limits bound simultaneous assignments, retries, and submissions. Completing an initiative requires all remaining tasks to pass review and all milestones to be accepted. Completion does not merge or publish changes.

Each task also shows its worker's current execution state, including pending approvals, questions, failures, and interruptions. A finished worker still needs to submit evidence and pass review. Open the worker to respond or inspect the result; reconnect before relying on a disconnected client's last known state. If a worker stop fails, retry that delivery before assigning its replacement or changing coordinators.

**Pause workers** stops assigned execution and cancels pending team notifications. **Resume** asks the coordinator to reconcile interrupted assignments and continue. **Cancel** retains the record; **Reopen** makes it active again. Reset a task to give it a fresh assignment. Reset dependent work before changing a prerequisite whose result it already uses. Changing the brief stops workers and requires fresh approval when plan approval is required, or a resume otherwise.

The board keeps decisions and questions together. A quiet update does not start an agent turn; select teammates to notify when a response is needed. Failed deliveries stay visible with a retry action.

Project knowledge is explicit: retain a useful fact, correct it, or forget it. Forgetting removes it from future Crew context; earlier messages and the correction history remain. **Context** shows the bounded packet supplied to a conversation and its sources. To hand over unfinished work, pause the crew, wait for execution to stop, and choose a fresh coordinator conversation. It receives current assignments, decisions, blockers, and reviews, including when using another supported provider. Resume initiatives explicitly.

Archive completed or cancelled initiatives to make room for new work. Search **History** for older discussions and evidence, or inspect the archive and restore an initiative. Restore leaves work paused and preserves assignments and approvals. Check artifact availability when revisiting older evidence: a recorded result can outlive its file or repository. Cleanup retains workspaces and checkpoints used by unfinished initiatives.

Crew state belongs to the project on its host environment. You can control it remotely from another client, but workers in one crew currently run on that same environment. Provider support for delegated work and worktrees follows the normal T3 delegation capabilities.
