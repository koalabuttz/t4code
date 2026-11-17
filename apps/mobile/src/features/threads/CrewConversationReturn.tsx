import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { crewReturnContext } from "@t3tools/client-runtime/state/crew";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import type { CrewPage } from "./TeamworkSheet";
import { openCrewPage } from "./crewProjectNavigation";

export function CrewConversationReturn({
  environmentId,
  projectId,
  threadId,
  page,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
  page: CrewPage;
}) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const context = useAtomValue(crewReturnContext(scopedProjectKey({ environmentId, projectId })));
  if (context?.threadId !== threadId) return null;
  return (
    <View className="gap-1 bg-secondary px-5 py-2" style={{ paddingTop: insets.top + 8 }}>
      {context.kind !== "conversation" && (
        <AppText>
          Opened from Crew for {context.kind === "question" ? "a question" : "an approval"}
          {context.requestId ? ` (${context.requestId})` : ""}. Respond to the current request in
          this conversation.
        </AppText>
      )}
      <Button
        label="Return to Crew"
        onPress={() => {
          if (navigation.canGoBack()) navigation.goBack();
          else openCrewPage(navigation, { environmentId, projectId }, page);
        }}
      />
    </View>
  );
}
