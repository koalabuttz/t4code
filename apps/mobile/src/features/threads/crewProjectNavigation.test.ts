import * as NodeModule from "node:module";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { openCrewPage, openCrewSource, selectCrewProjectTab } from "./crewProjectNavigation";

vi.mock("@react-navigation/native", async () => {
  const { createRequire } = await import("node:module");
  const requireNavigation = createRequire(
    createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
  );
  return requireNavigation("@react-navigation/routers");
});

const requireNavigation = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
);
const { StackRouter, StackActions, CommonActions } = requireNavigation(
  "@react-navigation/routers",
) as Pick<
  typeof import("@react-navigation/native"),
  "StackRouter" | "StackActions" | "CommonActions"
>;

const scope = {
  environmentId: EnvironmentId.make("environment"),
  projectId: ProjectId.make("project"),
};

function projectStack() {
  const router = StackRouter({});
  const options = {
    routeNames: ["Home", "Thread", "Crew"],
    routeParamList: {},
    routeGetIdList: {},
  };
  let state = router.getInitialState(options);
  const dispatch = (action: Parameters<typeof router.getStateForAction>[1]) => {
    const next = router.getStateForAction(state, action, options);
    if (!next) throw new Error(`Rejected ${action.type}`);
    state = router.getRehydratedState(next, options);
  };
  dispatch(StackActions.push("Crew", scope));
  return {
    navigation: {
      dispatch,
      navigate: () => {
        throw new Error("Expected a stack action");
      },
      getState: () => state,
    },
    current: () => state.routes[state.index]!,
    back: () => dispatch(CommonActions.goBack()),
  };
}

it("switches all project tabs on one route and goes Back to the original coordinator", () => {
  const { navigation, current, back } = projectStack();
  const coordinator = current();
  openCrewPage(navigation, scope, "threads");
  const projectKey = current().key;

  for (const tab of ["results", "project-settings", "threads", "results"] as const) {
    selectCrewProjectTab(navigation, projectKey, tab);
    expect(current()).toMatchObject({ key: projectKey, params: { ...scope, page: tab } });
  }

  back();
  expect(current()).toEqual(coordinator);
});

it("returns from evidence, settings, and exact-source threads to their originating tab", () => {
  const { navigation, current, back } = projectStack();
  openCrewPage(navigation, scope, "results");
  const projectKey = current().key;

  openCrewPage(navigation, scope, "task");
  expect(current().params).toMatchObject({ ...scope, page: "task" });
  const source = { ...scope, threadId: ThreadId.make("worker") };
  openCrewSource(navigation, scope, source);
  expect(current()).toMatchObject({
    name: "Thread",
    params: {
      environmentId: scope.environmentId,
      threadId: source.threadId,
      crewSourceProjectId: scope.projectId,
    },
  });
  back();
  expect(current().params).toMatchObject({ page: "task" });
  back();
  expect(current()).toMatchObject({ key: projectKey, params: { page: "results" } });

  selectCrewProjectTab(navigation, projectKey, "project-settings");
  openCrewPage(navigation, scope, "advanced");
  openCrewPage(navigation, scope, "recovery");
  back();
  expect(current().params).toMatchObject({ page: "advanced" });
  back();
  expect(current()).toMatchObject({ key: projectKey, params: { page: "project-settings" } });

  selectCrewProjectTab(navigation, projectKey, "threads");
  openCrewSource(navigation, scope, source);
  back();
  expect(current()).toMatchObject({ key: projectKey, params: { page: "threads" } });
});
