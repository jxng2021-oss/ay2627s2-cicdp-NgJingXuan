"use client";

import { createContext, useContext } from "react";
import type { Me, Overview } from "./api/client";

export interface WorkspaceState {
  id: string;
  me: Me;
  overview: Overview;
  isOwner: boolean;
  sealed: boolean;
  refresh: () => void;
}

export const WorkspaceContext = createContext<WorkspaceState | undefined>(
  undefined,
);

export function useWorkspace(): WorkspaceState {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error("useWorkspace outside a workspace page");
  return workspace;
}
