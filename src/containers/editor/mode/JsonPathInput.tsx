import { type ComponentPropsWithoutRef, type ElementRef, type FC, forwardRef } from "react";
import { Input } from "@/components/ui/input";
// import { ViewMode } from "@/lib/db/config"; // ViewMode and useEditorStore seems unused in the new logic
import { toastErr, toastSucc } from "@/lib/utils";
// import { useEditorStore } from "@/stores/editorStore";
import { getStatusState, useStatusStore } from "@/stores/statusStore"; // getStatusState added
import { getTreeState } from "@/stores/treeStore"; // getTreeState added
import { useTranslations } from "next-intl";
// import { useShallow } from "zustand/shallow"; // useShallow seems unused if we simplify useStatusStore usage
import InputBox from "./InputBox";

function useJsonPathSearch() {
  const t = useTranslations();
  // const secondary = useEditorStore((state) => state.secondary); // Not used in new logic
  // const { viewMode, setViewMode } = useStatusStore( // Not used in new logic
  //   useShallow((state) => ({
  //     viewMode: state.viewMode,
  //     setViewMode: state.setViewMode,
  //     setCommandMode: state.setCommandMode,
  //   })),
  // );

  return (jsonPathString: string) => {
    jsonPathString = jsonPathString.trim();

    if (!jsonPathString) {
      // User submitted an empty path, maybe clear selection or do nothing
      // For now, let's provide feedback that it's empty.
      toastErr(t("json_path_empty_input_err") || "JSON Path cannot be empty.");
      return;
    }

    const tree = getTreeState().main;

    if (!tree || !tree.valid()) {
      toastErr(t("json_path_invalid_tree_err") || "JSON data is not available or invalid.");
      return;
    }

    // Assuming findNodeByPath is now part of the Tree class instance
    const foundNode = tree.findNodeByPath(jsonPathString);

    if (foundNode) {
      getStatusState().setRevealPosition({ treeNodeId: foundNode.id, type: "node", from: "jsonPathSearch" });
      toastSucc(t("json_path_found_succ") || `Node found for path: ${jsonPathString}`);
    } else {
      toastErr(t("json_path_not_found_err") || `Node not found for path: ${jsonPathString}`);
    }
  };
}

const JsonPathInput: FC = forwardRef<ElementRef<typeof Input>, ComponentPropsWithoutRef<typeof Input>>(
  ({ className, ...props }, ref) => {
    const t = useTranslations();
    const search = useJsonPathSearch(); // Changed from useFilter to useJsonPathSearch

    // InputBox expects a run function that takes the input string
    return <InputBox id="json-path-input" run={search} placeholder={t("json_path_placeholder")} {...props} />;
  },
);

JsonPathInput.displayName = "JsonPathInput";
export default JsonPathInput;
