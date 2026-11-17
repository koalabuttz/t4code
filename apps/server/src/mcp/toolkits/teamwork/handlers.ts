import * as Effect from "effect/Effect";
import * as Access from "../../McpToolAccess.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Teamwork from "../../../teamwork/TeamworkMcpService.ts";
import { TeamworkToolkit } from "./tools.ts";

const handlers = {
  t3_crew_conversations: Access.readsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* Teamwork.TeamworkMcpService).conversationQuery(
        yield* Invocation.McpInvocationContext,
        input,
      );
    }),
  ),
  t3_crew_conversation_command: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* Teamwork.TeamworkMcpService).conversationCommand(
        yield* Invocation.McpInvocationContext,
        input,
      );
    }),
  ),
  t3_team_read: Access.readsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* Teamwork.TeamworkMcpService).read(
        yield* Invocation.McpInvocationContext,
        input,
      );
    }),
  ),
  t3_team_update: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* Teamwork.TeamworkMcpService).update(
        yield* Invocation.McpInvocationContext,
        input,
      );
    }),
  ),
  t3_team_delegate: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* Teamwork.TeamworkMcpService).delegate(
        yield* Invocation.McpInvocationContext,
        input,
      );
    }),
  ),
} satisfies Access.Handlers<typeof TeamworkToolkit.tools>;
export const layer = Access.toLayer(TeamworkToolkit, handlers);
