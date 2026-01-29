import { useAppStore } from "../store/useAppStore";
import { useMemo } from "react";

export function useEffectiveCwd(): string {
  const manualCwd = useAppStore((state) => state.cwd);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const sessions = useAppStore((state) => state.sessions);

  return useMemo(() => {
    const trimmedManual = manualCwd.trim();
    if (trimmedManual) return trimmedManual;
    if (activeSessionId) {
      const session = sessions[activeSessionId];
      if (session?.cwd) {
        return session.cwd.trim();
      }
    }
    return "";
  }, [manualCwd, activeSessionId, sessions]);
}
