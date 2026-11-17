# Albedo

Albedo runs a persistent Python environment behind a local daemon. T3 Code connects to that daemon, so reopening a conversation can reuse its native session and Python state.

Install and configure [Albedo](https://albedo.sh) on the machine running your T3 server, then start its daemon. In web or desktop **Settings → Providers**, add and enable Albedo. Set **Albedo home** to the directory containing its `daemon.json`, or leave it empty to use `ALBEDO_HOME` or `~/.albedo` on that machine. The daemon credential stays on the server, including when you connect remotely or use the mobile app.

Choose a profile and model in T3's model picker. Profiles and credentials are configured in Albedo; T3 lists their models and supported reasoning choices. Refresh the provider after changing its profiles. A missing profile or unsupported choice produces an error instead of switching models.

Use `/compact` to compact Albedo's model context while keeping the conversation history and Python state. If its response is lost, T3 reports the outcome as uncertain and does not repeat compaction automatically. Check the native session before requesting it again.

Albedo can use native children and peers without a Crew initiative. Their conversations and activity appear in T3, and native mail can wake the parent after its reply finishes. Use Crew for assignments and approval; a worker's native helpers remain part of that assignment.

**Stop** interrupts the conversation, closes its native helpers, and stops its background jobs while preserving the main Python kernel. Crew keeps reassignment blocked until the stop is confirmed. Stop requests survive T3 restarts. If the connection is lost, T3 reconnects to finish the request without submitting another prompt. Work remains unresolved until confirmation arrives. **Force stop** is unavailable for this persistent runtime.

Albedo currently requires **Full access**. Native Plan mode, conversation rollback, and native forks are unavailable in T3. Closing a T3 connection leaves the shared daemon and its sessions running. Manage Albedo installation and updates through Albedo itself.
