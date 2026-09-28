"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { browserClient } from "../supabase/browser";
import { api, ApiError, errorMessage } from "./api";
import { MessageTracker, sortedMessages } from "./presentation";
import type {
  Agent,
  Detail,
  Message,
  OfficeData,
  Project,
  Task,
} from "./types";

const empty: OfficeData = { projects: [], agents: [], tasks: [], detail: null };
/** Realtime is an invalidation stream. Serialized snapshots also recover missed events. */
export function useOffice(selectedId?: string) {
  const router = useRouter();
  const [data, setData] = useState<OfficeData>(empty),
    [loading, setLoading] = useState(true);
  const [error, setError] = useState(""),
    [connection, setConnection] = useState("연결 중");
  const [parcels, setParcels] = useState<Message[]>([]);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    let alive = true,
      busy = false,
      dirty = false,
      baseline = true,
      live = false,
      currentId = selectedId;
    const tracker = new MessageTracker();
    const refreshData = async () => {
      dirty = true;
      if (busy) return;
      busy = true;
      try {
        while (dirty && alive) {
          dirty = false;
          const [projects, agents, tasks] = await Promise.all([
            api<Project[]>("projects"),
            api<Agent[]>("agents"),
            api<Task[]>("tasks"),
          ]);
          const id = currentId ?? tasks[0]?.id;
          currentId = id;
          const detail = id ? await api<Detail>(`tasks/${id}`) : null;
          if (!alive) return;
          if (detail) {
            if (baseline || !live) tracker.baseline(detail.messages);
            else {
              const fresh = sortedMessages(detail.messages).filter((m) =>
                tracker.accept(m, detail.task.id, [
                  detail.task.lead_agent,
                  detail.task.reviewer_agent,
                ]),
              );
              if (fresh.length) setParcels((q) => [...q, ...fresh]);
            }
          }
          baseline = false;
          setData({ projects, agents, tasks, detail });
          setError("");
          setLoading(false);
        }
      } catch (e) {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 401) router.replace("/login");
        setError(errorMessage(e));
        setLoading(false);
      } finally {
        busy = false;
      }
    };
    refreshRef.current = refreshData;
    let cleanup = () => {};
    try {
      const client = browserClient();
      const channel = client.channel(`office-${crypto.randomUUID()}`);
      for (const table of ["tasks", "task_events", "agents", "agent_messages"])
        channel.on(
          "postgres_changes",
          { event: "*", schema: "public", table },
          () => {
            void refreshData();
          },
        );
      channel.subscribe((status: string) => {
        if (!alive) return;
        live = status === "SUBSCRIBED";
        setConnection(live ? "실시간 연결" : "연결 복구 중");
        baseline = true;
        setParcels([]);
        if (live) void refreshData();
      });
      cleanup = () => {
        void client.removeChannel(channel);
      };
    } catch (e) {
      queueMicrotask(() => {
        if (alive) {
          setConnection("연결 설정 필요");
          setError(errorMessage(e));
        }
      });
    }
    void refreshData();
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        baseline = true;
        setParcels([]);
        void refreshData();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      cleanup();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [selectedId, router]);
  const parcel = parcels[0] ?? null;
  useEffect(() => {
    if (!parcel) return;
    const id = setTimeout(() => setParcels((q) => q.slice(1)), 1600);
    return () => clearTimeout(id);
  }, [parcel]);
  return { data, loading, error, connection, refresh, parcel };
}
