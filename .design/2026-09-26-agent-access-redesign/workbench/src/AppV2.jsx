import HistoryLocationDialog from "./HistoryLocationDialog.jsx";
import HistoryStartDialog, { SavedDrafts } from "./HistoryStartDialog.jsx";
import { preserveDraft, historySourceIssue } from "./history-start-state.js";
import { libraryProtection } from "./settings-library-state.js";
import { additionalOptionsFor } from "./agent-catalog.js";
import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  SidebarSimple,
  Check,
  ChatCircle,
  Sparkle,
  Key,
  Gear,
  Compass,
} from "@phosphor-icons/react";
import { Button, Modal, Empty } from "./ui";
import SidebarV2 from "./SidebarV2";
import ReviewDialogs from "./ReviewDialogs.jsx";
import LibraryDialogs from "./LibraryDialogs.jsx";
import WorkPolicyDialog from "./WorkPolicyDialog.jsx";
import ReviewToolbar from "./ReviewToolbar.jsx";
import DraftRecoveryNotice from "./DraftRecoveryNotice.jsx";
import AttachmentRecoveryDialog from "./AttachmentRecoveryDialog.jsx";
import {
  readPrototypeState,
  saveArchiveDecision,
  writePrototypeState,
  PROTOTYPE_STORAGE_KEY,
} from "./prototype-persistence.js";
import {
  conversationState,
  applyConversationPatch,
} from "./conversation-policy.js";
import {
  archiveEligibility,
  visibleInActive,
  patchConversationMetadata,
  applyArchivePolicy,
} from "./history-policy.js";
import "./logic-completion.css";
import NewConversationV2 from "./NewConversationV2";
import ConversationLibrary from "./ConversationLibrary";
import Conversation from "./Conversation";
import AgentHub from "./AgentHub";
import AccountWorkReturn from "./AccountWorkReturn.jsx";
import useAccountWorkReturn from "./useAccountWorkReturn.js";
import {
  selectionMatchesAgent,
  preparationIntentEntry,
  pendingOnboardingForEntry,
} from "./setup-entry.js";
import {
  setupContextForEntry,
  preparationWork,
  conversationPreparationRequest,
} from "./preparation-navigation.js";
import ImportConversations from "./ImportConversations.jsx";
import { mergeImportedTasks } from "./import-state.js";
import {
  permissionCapabilityFor,
  permissionSelectionFor,
} from "./agent-catalog";
import { migrateBuiltinAccountCapabilities } from "./account-capabilities.js";
import WorkbenchSettings from "./WorkbenchSettings.jsx";
import RedesignGuide from "./RedesignGuide.jsx";
import { currentModelOptions } from "./model-read-state.js";
import {
  reviewAgents,
  managementRequest,
  preparationSelection,
} from "./review-navigation.js";
import { firstUseState, exampleState } from "./scene-state.js";
import {
  usesApi,
  selectedService,
  serviceChoiceIssue,
  continuationIssue,
} from "./service-access.js";
import "./settings.css";
import "./settings-extra.css";
import "./v2.css";
import "./layout-refinement.css";
import "./flow-integration.css";
import "./workbench.css";
import { advanceAgentJobs } from "./access-jobs.js";
import {
  firstSendAuthDestination,
  firstSendFailure,
  settleSuccessfulFirstSend,
} from "./first-send-auth.js";
import { syncAccessTestTasks, actOnAccessTest } from "./access-test-tasks.js";
import {
  hasDraftContent,
  makeAttempt,
  admittedConversation,
  draftSignature,
  authScopeKey,
  rememberAuthFailure,
  settleSuccessfulAuthBlock,
  releasePreparedAuthFailure,
  completePreparation,
  preparationReturn,
  preparationEntry,
  scopedAuthIssue,
} from "./workbench-state.js";

import { agentCanStartConversation } from "./agent-setup-state.js";

const EMPTY_FILTER = { agent: "", group: "", state: "all", query: "" };
export default function AppV2() {
  const [restoredState] = useState(() => readPrototypeState(localStorage));
  const [initialState] = useState(() => restoredState || firstUseState());
  const [restoredDraft, setRestoredDraft] = useState(
    Boolean(restoredState?.draft?.text || restoredState?.draft?.files?.length),
  );
  const [attachmentsNeedReview, setAttachmentsNeedReview] = useState(
    Boolean(restoredState?.attachmentsNeedReview),
  );
  const [storageIssue, setStorageIssue] = useState(false);
  const [archiveDays, setArchiveDays] = useState(
    restoredState?.archiveDays || "30",
  );
  const [view, setView] = useState(restoredState?.view || "new"),
    [active, setActive] = useState(restoredState?.active || null),
    [origin, setOrigin] = useState("new");
  const [tasks, setTasks] = useState(() => initialState.tasks),
    [groups, setGroups] = useState(initialState.groups || []);
  const [agents, setAgents] = useState(
      () =>
        initialState.agents?.map(migrateBuiltinAccountCapabilities) ||
        firstUseState().agents,
    ),
    [services, setServices] = useState(() => initialState.services || []);
  const [filters, setFilters] = useState(
      restoredState?.filters || { ...EMPTY_FILTER },
    ),
    [draft, setDraft] = useState(restoredState?.draft?.text || ""),
    [choice, setChoice] = useState(initialState.draft.choice),
    [files, setFiles] = useState(restoredState?.draft?.files || []),
    [folder, setFolder] = useState(restoredState?.draft?.folder || "");
  useEffect(() => {
    const timer = setInterval(
      () => setAgents((previous) => advanceAgentJobs(previous, Date.now())),
      400,
    );
    return () => clearInterval(timer);
  }, []);
  const [pendingSend, setPendingSend] = useState(null);
  const [sendError, setSendError] = useState("");
  const [authBlocks, setAuthBlocks] = useState(restoredState?.authBlocks || {});
  const [prepareEntry, setPrepareEntry] = useState(null);
  const [settingsContext, setSettingsContext] = useState(null);
  const testPreparationReturn = useRef({});
  const [pendingChoice, setPendingChoice] = useState(null);
  const [workPolicies, setWorkPolicies] = useState(
    restoredState?.workPolicies || {},
  );
  const draftNow = useRef(null);
  draftNow.current = { text: draft, files, folder, choice };
  const sendTicket = useRef(0);
  const [hubRequest, setHubRequest] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [importTarget, setImportTarget] = useState(null);
  const [importRequest, setImportRequest] = useState(0);
  const [locationTask, setLocationTask] = useState(null);
  const [historyStart, setHistoryStart] = useState(null);
  const [historyStartError, setHistoryStartError] = useState("");
  const [savedDrafts, setSavedDrafts] = useState(
    restoredState?.savedDrafts || [],
  );
  const [notificationPreferences, setNotificationPreferences] = useState(
    restoredState?.notificationPreferences || { enabled: false, sound: false },
  );
  const [newLocation, setNewLocation] = useState("");
  const openImport = (name) => {
    setImportTarget(typeof name === "string" ? name : null);
    setImportRequest((x) => x + 1);
    setImportOpen(true);
  };
  const [hubTarget, setHubTarget] = useState(null),
    [settingsTab, setSettingsTab] = useState("general"),
    [settingsOrigin, setSettingsOrigin] = useState("new");
  const [collapsed, setCollapsed] = useState(false),
    [mobile, setMobile] = useState(false),
    [modal, setModal] = useState(null),
    [toastText, setToast] = useState("");
  const [search, setSearch] = useState(""),
    [name, setName] = useState(""),
    [moveIds, setMoveIds] = useState([]),
    [renameId, setRenameId] = useState(null),
    [scene, setScene] = useState(initialState.scene),
    [revision, setRevision] = useState(0);
  const [theme, setTheme] = useState(restoredState?.theme || "light"),
    [systemDark, setSystemDark] = useState(
      () => matchMedia("(prefers-color-scheme: dark)").matches,
    );
  const [feedback, setFeedback] = useState(() => {
      try {
        return JSON.parse(
          localStorage.getItem("farfold-design-feedback-v1") || "[]",
        );
      } catch {
        return [];
      }
    }),
    [feedbackText, setFeedbackText] = useState(""),
    [rating, setRating] = useState("需要调整");
  const toastTimer = useRef(),
    visible = useRef({ view, active });
  visible.current = { view, active };
  const snapshotNow = useRef(null);
  snapshotNow.current = {
    scene,
    tasks,
    groups,
    agents,
    authBlocks,
    workPolicies,
    services,
    filters,
    archiveDays,
    savedDrafts,
    notificationPreferences,
    theme,
    draft: { text: draft, files, folder, choice },
    pendingSend,
    view: ["new", "thread", "conversations", "starred"].includes(view)
      ? view
      : "new",
    active,
  };
  useEffect(() => {
    const saved = writePrototypeState(localStorage, snapshotNow.current);
    setStorageIssue(!saved);
  }, [
    scene,
    tasks,
    groups,
    agents,
    authBlocks,
    workPolicies,
    services,
    filters,
    archiveDays,
    savedDrafts,
    notificationPreferences,
    theme,
    draft,
    files,
    folder,
    choice,
    pendingSend,
    view,
    active,
  ]);
  const commitArchive = (days, announce = false) => {
    const state = snapshotNow.current;
    const result = applyArchivePolicy(state.tasks, days);
    if (!result.count && String(days) === state.archiveDays) {
      if (announce) toast("没有符合条件的对话，已有内容保持不变。");
      return;
    }
    const saved = saveArchiveDecision(localStorage, state, result, days);
    if (!saved.ok) {
      setStorageIssue(true);
      toast("整理结果未能保存，原归档与设置保持不变。");
      return;
    }
    snapshotNow.current = saved.state;
    setStorageIssue(false);
    setTasks(saved.state.tasks);
    setArchiveDays(saved.state.archiveDays);
    if (announce)
      toast(
        result.count
          ? `已归档 ${result.count} 段对话，仍可在已归档中恢复。`
          : "归档规则已保存。",
      );
  };
  const runArchive = () => commitArchive(snapshotNow.current.archiveDays, true);
  useEffect(() => {
    commitArchive(snapshotNow.current.archiveDays);
    const timer = setInterval(
      () => commitArchive(snapshotNow.current.archiveDays),
      60000,
    );
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    for (const agent of agents) {
      const job = agent.accessJob;
      if (job?.type === "test" && !testPreparationReturn.current[job.id])
        testPreparationReturn.current[job.id] = {
          entry: structuredClone(prepareEntry),
          agent: agent.name,
        };
    }
    setTasks((previous) =>
      syncAccessTestTasks(
        previous,
        agents,
        services,
        visible.current.view === "thread" ? visible.current.active : null,
      ),
    );
  }, [agents, services]);
  const toast = (text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3500);
  };
  useEffect(() => {
    const m = matchMedia("(prefers-color-scheme: dark)"),
      f = () => setSystemDark(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  const go = (
    v,
    { preserveFilters = false, preservePreparation = false } = {},
  ) => {
    if (v === "agents" && view !== "agents" && !preservePreparation)
      setPrepareEntry(null);
    setView(v);
    setMobile(false);
    if (!preserveFilters && ["conversations", "starred"].includes(v))
      setFilters({ ...EMPTY_FILTER });
  };
  const patch = (id, update) => {
    const state = snapshotNow.current;
    const current = state.tasks.find((task) => task.id === id);
    if (update.archived && current && !archiveEligibility(current).allowed) {
      toast(archiveEligibility(current).reason);
      return;
    }
    const nextTasks = state.tasks.map((task) => {
      if (task.id !== id) return task;
      const next = applyConversationPatch(task, update);
      const changes = Object.fromEntries(
        Object.entries(next).filter(([key, value]) => value !== task[key]),
      );
      const result = patchConversationMetadata(task, changes);
      return {
        ...result.task,
        ...(next.status && next.status !== task.status ? { time: "刚刚" } : {}),
        ...(next.status === "done" && task.status !== "done"
          ? {
              unread: !(
                visible.current.view === "thread" &&
                visible.current.active === id
              ),
            }
          : {}),
      };
    });
    const nextState = { ...state, tasks: nextTasks };
    if (
      Object.hasOwn(update, "archived") &&
      !writePrototypeState(localStorage, nextState)
    ) {
      setStorageIssue(true);
      toast("整理结果未能保存，原对话保持不变。");
      return;
    }
    snapshotNow.current = nextState;
    setTasks(nextTasks);
  };
  const open = (t) => {
    if (view !== "thread")
      setOrigin(
        view === "settings"
          ? settingsOrigin === "thread"
            ? origin
            : settingsOrigin
          : view,
      );
    setActive(t.id);
    patch(t.id, { unread: false });
    go("thread");
  };
  const explore = (n, request = {}) => {
    if (view !== "agents" || Object.keys(request).length)
      setPrepareEntry({
        ...(view === "agents" && prepareEntry
          ? prepareEntry
          : preparationEntry({
              view,
              active,
              tasks,
              draft: draftNow.current,
              settingsContext,
            })),
        ...request,
      });
    setHubTarget(n || null);
    setHubRequest((x) => x + 1);
    setView("agents");
    setMobile(false);
  };
  const prepareImportedAgent = (name) => {
    if (!name) return explore();
    const agent = agents.find((item) => item.name === name || item.id === name);
    if (!agent) return explore();
    setPrepareEntry({
      view,
      active,
      contextView: "agents",
      intent: "import",
      importAgent: agent.name,
      agent: agent.name,
      choice: agentChoice(agent.name, agent),
      folder: "",
    });
    setHubTarget(agent.name);
    setHubRequest((value) => value + 1);
    go("agents", { preservePreparation: true });
  };
  const returnFromPreparation = (entry) => {
    const destination = preparationReturn(entry);
    setHubTarget(null);
    setPrepareEntry(
      entry?.intent === "manage" && entry?.contextView === "agents"
        ? entry
        : null,
    );
    if (destination.active != null) setActive(destination.active);
    go(destination.view, { preserveFilters: true, preservePreparation: true });
    if (destination.importAgent) openImport(destination.importAgent);
  };
  const {
    authWorkReturn,
    openBlockingWork,
    returnToAccount,
    clearAccountReturn,
  } = useAccountWorkReturn({
    tasks,
    entry: prepareEntry,
    onOpen: open,
    onRestore: (saved) => {
      setPrepareEntry(saved.entry);
      setHubTarget(saved.target);
      setHubRequest((value) => value + 1);
      setView("agents");
    },
  });
  const openSettings = (tab) => {
    if (tab === "agents") {
      explore(null, managementRequest());
      return;
    }
    if (view !== "settings") {
      setSettingsOrigin(view);
      const testReturn =
        view === "thread" ? testPreparationReturn.current[active] : null;
      setSettingsContext(
        testReturn?.entry
          ? structuredClone(testReturn.entry)
          : view === "agents" && prepareEntry
            ? structuredClone(prepareEntry)
            : preparationEntry({
                view,
                active,
                tasks,
                draft: draftNow.current,
              }),
      );
    }
    setSettingsTab(tab || "general");
    go("settings");
  };
  const newChat = () => {
    setActive(null);
    go("new");
  };
  const filterTo = (key, value) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setView("conversations");
    setMobile(false);
  };
  useEffect(() => {
    const key = (e) => {
      if (
        e.defaultPrevented ||
        !(e.metaKey || e.ctrlKey) ||
        modal ||
        importOpen ||
        [
          ...document.querySelectorAll('[role="dialog"][aria-modal="true"]'),
        ].some((dialog) => dialog.getClientRects().length > 0)
      )
        return;
      if (e.key === "k") {
        e.preventDefault();
        setSearch("");
        setModal("search");
      }
      if (e.key === "n") {
        e.preventDefault();
        newChat();
      }
      if (e.key === ",") {
        e.preventDefault();
        openSettings("general");
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [modal, view, importOpen]);
  const send = () => {
    if (!folder) {
      setSendError("发送前请选择工作文件夹，草稿已保留。");
      return;
    }
    if (!hasDraftContent(draft, files) || pendingSend) return;
    if (choice.requiresSourceSelection || choice.configurationChange) {
      setSendError("请先确认来源与设置，再发送。草稿仍保留。");
      return;
    }
    if (attachmentsNeedReview && files.length) {
      setModal("restore-attachments");
      return;
    }
    const a = agents.find((x) => selectionMatchesAgent(x, choice));
    if (
      !agentCanStartConversation(a) ||
      pendingOnboardingForEntry(a, choice, { view: "new", folder })
    ) {
      explore(choice.agentId || choice.agent, { intent: "use" });
      return;
    }
    const service = usesApi(choice) ? selectedService(choice, services) : null;
    const authIssue = scopedAuthIssue(
      authBlocks,
      { ...draftNow.current, service },
      a,
    );
    if (authIssue) {
      setSendError(authIssue);
      if (firstSendAuthDestination(a, draftNow.current) === "agent")
        explore(a.id, { repair: "account", panel: "account" });
      else openSettings("api");
      return;
    }
    if (workPolicies[folder || "普通对话"] === false) {
      setSendError("已暂停发送。恢复后，由你重新发送。");
      return;
    }
    const issue = serviceChoiceIssue(choice, a, services);
    if (issue) {
      setSendError(issue);
      return;
    }
    const attempt = makeAttempt({
      ...draftNow.current,
      service,
      outcome: "success",
      permission: permissionSelectionFor(a, choice),
      id: "new-" + Date.now(),
    });
    const ticket = ++sendTicket.current;
    setPendingSend(attempt);
    setSendError("");
    setTimeout(() => {
      if (ticket !== sendTicket.current) return;
      setPendingSend(null);
      const task = admittedConversation(attempt);
      if (!task) {
        const failure = firstSendFailure(a, attempt);
        if (failure.rememberBlock)
          setAuthBlocks((previous) =>
            rememberAuthFailure(previous, attempt, a.lastAccessResult?.id),
          );
        if (["agent", "service"].includes(failure.layer))
          setAgents((list) =>
            list.map((item) =>
              !selectionMatchesAgent(item, attempt.draft.choice)
                ? item
                : firstSendFailure(item, attempt).agent,
            ),
          );
        setSendError(failure.message);
        return;
      }
      if (attempt.outcome === "success") {
        setAuthBlocks((previous) =>
          settleSuccessfulAuthBlock(previous, attempt),
        );
        setAgents((list) =>
          list.map((a) =>
            selectionMatchesAgent(a, task)
              ? {
                  ...settleSuccessfulFirstSend(a, attempt),
                  connected: true,
                  added: true,
                  registered: true,
                  connectionState: "connected",
                }
              : a,
          ),
        );
      }
      setTasks((list) => [
        { ...task, lastActivityAt: Date.now(), lastActivityKnown: true },
        ...list,
      ]);
      const unchanged = draftSignature(draftNow.current) === attempt.signature;
      if (unchanged) {
        setDraft("");
        setFiles([]);
      }
      if (visible.current.view === "new" && unchanged) {
        setActive(task.id);
        setOrigin("new");
        setView("thread");
      } else toast("刚才的消息已进入对话，可从所有对话中查看。");
    }, 650);
  };
  const agentChoice = (agentName, prepared) => {
    const a = prepared || agents.find((x) => x.name === agentName);
    return {
      agent: agentName,
      agentId: a?.id,
      model: a?.model ?? a?.selectedModel ?? a?.models?.[0] ?? "",
      source: a?.source || "沿用已有设置",
      serviceId: a?.sourceId,
      serviceSnapshot:
        a?.accessMode === "api"
          ? structuredClone(
              a?.serviceSnapshot ||
                services.find((s) => s.id === a?.sourceId) ||
                null,
            )
          : null,
      accessMode: a?.accessMode || "existing",
      effort: a?.effort || a?.efforts?.[0] || "",
    };
  };
  const applyPreparedChoice = (next) => {
    setChoice(next);
    setPendingChoice(null);
    setModal(null);
    setHubTarget(null);
    setPrepareEntry(null);
    setSendError("");
    go("new");
    toast("已带回选择，内容由你确认后发送。");
  };
  const useAgent = (agentName, prepared, { intent = "complete" } = {}) => {
    const next = agentChoice(agentName, prepared);
    const entry =
      intent === "new"
        ? { view: "new-intent", intent: "use" }
        : {
            ...prepareEntry,
            intent: intent === "complete" ? prepareEntry?.intent : intent,
          };
    const contextChoice =
      (entry?.contextView || entry?.view) === "thread" ? entry.choice : next;
    if (usesApi(contextChoice) || entry) {
      const context = {
        choice: contextChoice,
        folder: entry?.folder ?? "",
        service: usesApi(contextChoice)
          ? selectedService(contextChoice, services)
          : null,
      };
      setAuthBlocks((previous) =>
        releasePreparedAuthFailure(previous, context, prepared),
      );
    }
    const transition = completePreparation(entry, draftNow.current, next);
    if (!transition.applyChoice) {
      setPendingChoice(null);
      setModal(null);
      returnFromPreparation(entry);
      toast(
        entry.intent === "import"
          ? "已返回已有对话，原来的列表与选择保留。"
          : entry.intent === "manage"
            ? "设置已保存，现有草稿保持不变。"
            : "已返回原页面，原对话设置和未发草稿保持不变。",
      );
      return;
    }
    if (transition.conflict) {
      setPendingChoice(next);
      setModal("agent-draft");
      return;
    }
    applyPreparedChoice(next);
  };
  const conversationIssue = (task) => {
    const agent = agents.find((item) => selectionMatchesAgent(item, task));
    return (
      continuationIssue(task, services, agent) ||
      scopedAuthIssue(
        authBlocks,
        {
          choice: task,
          folder: task.folder || "",
          service: usesApi(task) ? selectedService(task, services) : null,
        },
        agent,
      )
    );
  };
  const openTest = (id) => {
    const agent = agents.find(
      (item) => item.accessJob?.id === id || item.lastAccessResult?.id === id,
    );
    if (!agent && !tasks.some((task) => task.id === id && task.accessTest))
      return;
    if (!testPreparationReturn.current[id])
      testPreparationReturn.current[id] = {
        entry: structuredClone(prepareEntry),
        agent: agent?.name,
      };
    setTasks((previous) => syncAccessTestTasks(previous, agents, services, id));
    setActive(id);
    setOrigin("agents");
    setView("thread");
  };
  const returnToPreparation = (id) => {
    const saved = testPreparationReturn.current[id];
    if (!saved) return;
    setPrepareEntry(structuredClone(saved.entry));
    setHubTarget(saved.agent);
    setHubRequest((value) => value + 1);
    setView("agents");
  };
  const applyHistoryStart = (next, restoredId = null) => {
    const result = preserveDraft(
      draftNow.current,
      next,
      savedDrafts,
      crypto.randomUUID(),
      restoredId,
    );
    const nextState = {
      ...snapshotNow.current,
      ...result,
      view: "new",
      active: null,
    };
    if (!writePrototypeState(localStorage, nextState)) {
      setHistoryStartError("新草稿未能保存，原内容保持不变。请重试或取消。");
      toast("未能保存草稿，原内容保持不变。");
      return false;
    }
    snapshotNow.current = nextState;
    setSavedDrafts(result.savedDrafts);
    setDraft(next.text);
    setFiles(next.files);
    setAttachmentsNeedReview(Boolean(next.files.length));
    setChoice(result.draft.choice);
    setFolder(next.folder);
    setHistoryStart(null);
    setHistoryStartError("");
    setModal(null);
    newChat();
    return true;
  };
  const startFromHistory = (
    task,
    nextFolder = task.folder || "",
    message = null,
  ) => {
    setHistoryStart({ task, folder: nextFolder, message });
    setHistoryStartError("");
    setModal(null);
  };
  const saveNotificationPreferences = (next) => {
    const nextState = { ...snapshotNow.current, notificationPreferences: next };
    if (!writePrototypeState(localStorage, nextState)) return false;
    snapshotNow.current = nextState;
    setNotificationPreferences(next);
    return true;
  };
  const deleteConversation = (id) => {
    const state = snapshotNow.current;
    const target = state.tasks.find((task) => task.id === id);
    if (!target || libraryProtection(target)) {
      toast(target ? libraryProtection(target) : "未找到这段对话。");
      return false;
    }
    const nextState = {
      ...state,
      tasks: state.tasks.filter((task) => task.id !== id),
    };
    if (!writePrototypeState(localStorage, nextState)) {
      toast("删除结果未能保存，原对话保留。");
      return false;
    }
    snapshotNow.current = nextState;
    setTasks(nextState.tasks);
    setActive(null);
    go("conversations");
    toast("示例对话已删除；没有操作真实历史。");
    return true;
  };
  const needs = tasks.filter(
    (t) => visibleInActive(t) && conversationState(t).attention,
  );
  const running = tasks.filter(
    (t) => visibleInActive(t) && conversationState(t).running,
  );
  const startProps = {
    active: view === "new",
    draft,
    setDraft,
    choice,
    setChoice,
    agents,
    services,
    files,
    setFiles,
    folder,
    setFolder,
    onSend: send,
    onExplore: explore,
    pending: Boolean(pendingSend),
    sendError,
    onChoiceChange: () => setSendError(""),
    apiAuthBlocked: Boolean(
      usesApi(choice) &&
      authBlocks[
        authScopeKey({
          ...draftNow.current,
          service: selectedService(choice, services),
        })
      ],
    ),
    workEnabled: workPolicies[folder || "普通对话"] !== false,
    onResumeSending: () =>
      setWorkPolicies((p) => ({ ...p, [folder || "普通对话"]: true })),
    onManageServices: () => openSettings("api"),
  };
  const libraryProps = {
    tasks,
    groups,
    filters,
    setFilters,
    onOpen: open,
    onPatch: patch,
    onNew: newChat,
    onImport: () => openImport(),
    onDelete: (ids) =>
      setTasks((previous) => previous.filter((task) => !ids.includes(task.id))),
    onMove: (ids) => {
      setMoveIds(ids);
      setModal("move");
    },
    onRename: (t) => {
      setRenameId(t.id);
      setName(t.title);
      setModal("rename");
    },
  };
  const saveFeedback = () => {
    if (!feedbackText.trim()) return;
    const f = [
      {
        page:
          "交互原型 · " +
          (view === "thread"
            ? tasks.find((t) => t.id === active)?.title
            : view),
        text: feedbackText.trim(),
        rating,
        at: new Date().toLocaleString("zh-CN"),
      },
      ...feedback,
    ];
    setFeedback(f);
    localStorage.setItem("farfold-design-feedback-v1", JSON.stringify(f));
    setFeedbackText("");
    setModal(null);
    toast("意见已保存在这个浏览器里。");
  };
  const exportFeedback = () => {
    const blob = new Blob([JSON.stringify(feedback, null, 2)], {
        type: "application/json",
      }),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = "farfold-design-feedback.json";
    a.click();
    URL.revokeObjectURL(url);
  };
  const reset = (withExamples = false) => {
    const fresh = withExamples ? exampleState() : firstUseState();
    localStorage.removeItem(PROTOTYPE_STORAGE_KEY);
    setRestoredDraft(false);
    setAttachmentsNeedReview(false);
    setArchiveDays("30");
    setSavedDrafts([]);
    setNotificationPreferences({ enabled: false, sound: false });
    sendTicket.current++;
    setPendingSend(null);
    setSendError("");
    setAuthBlocks({});
    setPrepareEntry(null);
    setSettingsContext(null);
    testPreparationReturn.current = {};
    clearAccountReturn();
    setPendingChoice(null);
    setWorkPolicies({});
    setTasks(fresh.tasks);
    setAgents(fresh.agents);
    setServices(fresh.services);
    setGroups(fresh.groups);
    setChoice(fresh.draft.choice);
    setDraft("");
    setFiles([]);
    setFolder("");
    setFilters({ ...EMPTY_FILTER });
    setOrigin("new");
    setHubTarget(null);
    setScene(fresh.scene);
    setImportOpen(false);
    setImportTarget(null);
    setLocationTask(null);
    setHistoryStart(null);
    setActive(fresh.active);
    setSettingsOrigin("new");
    setRevision((x) => x + 1);
    setModal(null);
    go(fresh.view);
  };
  const navigateReview = (target) => {
    setModal(null);
    if (target === "new") return newChat();
    if (target === "agents") return explore();
    if (target === "manage") return openSettings("agents");
    if (["general", "api", "life"].includes(target))
      return openSettings(target);
    if (target === "import") return openImport();
    if (target === "search") {
      setSearch("");
      setModal("search");
      return;
    }
    if (["conversations", "starred"].includes(target)) return go(target);
    const demo = exampleState();
    setTasks((existing) => [
      ...existing,
      ...demo.tasks.filter((t) => !existing.some((old) => old.id === t.id)),
    ]);
    setGroups((existing) => [...new Set([...existing, ...demo.groups])]);
    setServices((existing) => [
      ...existing,
      ...demo.services.filter((s) => !existing.some((old) => old.id === s.id)),
    ]);
    setAgents((existing) =>
      reviewAgents(existing, demo.agents, firstUseState().agents),
    );
    const task =
      demo.tasks.find((t) =>
        target === "workspace"
          ? t.workspaceKind === "review" || t.id === "workspace-review"
          : t.status === target,
      ) ||
      demo.tasks.find((t) => t.id.startsWith("workspace")) ||
      demo.tasks[0];
    setActive(task.id);
    setOrigin("conversations");
    go("thread");
  };
  return (
    <div
      className={
        "v2-app " +
        (collapsed ? "sidebar-collapsed" : "") +
        (mobile ? " mobile-open" : "")
      }
      data-theme={
        theme === "dark" || (theme === "system" && systemDark)
          ? "dark"
          : "light"
      }
    >
      <ReviewToolbar
        pendingSend={Boolean(pendingSend)}
        setModal={setModal}
        storageIssue={storageIssue}
      />
      <div className="v2-layout">
        <SidebarV2
          view={view}
          managementMode={prepareEntry?.directoryView === "added"}
          onManageAgents={() => openSettings("agents")}
          onOpenRecent={open}
          tasks={tasks}
          agents={agents}
          groups={groups}
          filters={filters}
          go={go}
          onNew={newChat}
          onSearch={() => {
            setSearch("");
            setModal("search");
          }}
          onAddGroup={() => {
            setName("");
            setModal("group");
          }}
          onAgent={(a) => filterTo("agent", a)}
          onGroup={(g) => filterTo("group", g)}
          needsCount={needs.length}
          runningCount={running.length}
          hasDraft={Boolean(draft.trim() || files.length)}
          onStatus={(state) => {
            setFilters({ ...EMPTY_FILTER, state });
            go("conversations", { preserveFilters: true });
          }}
          onSettings={() => openSettings("general")}
          onCollapse={() => {
            setCollapsed(true);
            setMobile(false);
          }}
        />
        <main className="v2-main">
          {authWorkReturn && view !== "agents" && (
            <AccountWorkReturn
              target={authWorkReturn.label}
              onReturn={returnToAccount}
            />
          )}
          {view !== "thread" && (
            <div className="v2-windowbar">
              <div>
                <button
                  className={collapsed ? "" : "v2-mobile-nav"}
                  aria-label="展开导航"
                  onClick={() => {
                    setCollapsed(false);
                    setMobile(!mobile);
                  }}
                >
                  <SidebarSimple size={18} />
                </button>
                <span>
                  {view === "agents"
                    ? prepareEntry?.directoryView === "added"
                      ? "管理 Agent"
                      : "探索 Agent"
                    : view === "settings"
                      ? "设置"
                      : view === "conversations"
                        ? "对话"
                        : view === "starred"
                          ? "收藏"
                          : "新对话"}
                </span>
              </div>
              <div className="workbench-window-actions">
                {(draft.trim() || files.length > 0) && view !== "new" && (
                  <button className="v2-draft-return" onClick={newChat}>
                    继续草稿
                  </button>
                )}
              </div>
            </div>
          )}
          {
            <div
              className="v2-scroll"
              style={{ display: view === "new" ? "block" : "none" }}
            >
              <div className="v2-new-content">
                <SavedDrafts
                  items={savedDrafts}
                  onRestore={(item) =>
                    applyHistoryStart(
                      {
                        ...item.draft,
                        choice: {
                          ...item.draft.choice,
                          requiresSourceSelection: Boolean(
                            historySourceIssue(
                              item.draft.choice,
                              agents,
                              services,
                              item.draft.folder,
                            ),
                          ),
                        },
                      },
                      item.id,
                    )
                  }
                />
                <NewConversationV2
                  {...startProps}
                  recoveryNotice={
                    <DraftRecoveryNotice
                      restored={restoredDraft}
                      files={files}
                      attachmentsNeedReview={
                        attachmentsNeedReview && files.length > 0
                      }
                      onConfirmAttachments={() =>
                        setModal("restore-attachments")
                      }
                      storageIssue={storageIssue}
                      onDismiss={() => setRestoredDraft(false)}
                    />
                  }
                />
              </div>
            </div>
          }
          {(view === "conversations" || view === "starred") && (
            <div className="v2-scroll">
              <div className="v2-page-content">
                <ConversationLibrary
                  {...libraryProps}
                  starred={view === "starred"}
                />
              </div>
            </div>
          )}
          <div
            className="v2-hub-holder"
            style={{ display: view === "agents" ? "flex" : "none" }}
            key={"hub-" + revision}
          >
            <AgentHub
              agents={agents}
              tasks={preparationWork(tasks, pendingSend)}
              setAgents={setAgents}
              services={services}
              setServices={setServices}
              onUse={useAgent}
              onPreparationIntent={(intent) =>
                setPrepareEntry((entry) =>
                  preparationIntentEntry(entry, intent, draftNow.current),
                )
              }
              onOpenTest={openTest}
              toast={toast}
              initialAgent={hubTarget}
              initialSelection={preparationSelection(prepareEntry, choice)}
              initialContext={setupContextForEntry(
                prepareEntry ?? { view: "agents", folder, agent: choice.agent },
              )}
              initialRequest={hubRequest}
              onImportExisting={openImport}
              onOpenBlockingTask={openBlockingWork}
              onManageServices={() => openSettings("api")}
              returnLabel={
                prepareEntry?.intent === "import"
                  ? "返回已有对话"
                  : prepareEntry?.view === "new"
                    ? "返回草稿"
                    : prepareEntry
                      ? "返回原页面"
                      : undefined
              }
              onReturnToTask={
                prepareEntry
                  ? () => returnFromPreparation(prepareEntry)
                  : undefined
              }
            />
          </div>
          {view === "thread" && !tasks.some((task) => task.id === active) && (
            <Empty
              icon={ChatCircle}
              title="未找到这段对话"
              action={<Button onClick={newChat}>返回新对话</Button>}
            >
              可以返回新对话，或从“所有对话”打开现有内容。
            </Empty>
          )}
          {tasks.map((t) => (
            <div
              className="v2-conversation-holder"
              key={revision + "-" + t.id + "-" + (t.resetVersion || 0)}
              style={{
                display: view === "thread" && active === t.id ? "flex" : "none",
              }}
            >
              <Conversation
                task={t}
                groups={groups}
                onMoveToGroup={(id, group) => patch(id, { group })}
                onDeleteConversation={deleteConversation}
                onNewFromMessage={(message) =>
                  startFromHistory(t, t.folder || "", message)
                }
                onBack={() =>
                  authWorkReturn?.taskId === t.id
                    ? returnToAccount()
                    : t.accessTest && origin === "agents"
                      ? returnToPreparation(t.id)
                      : go(origin, { preserveFilters: true })
                }
                navigationCollapsed={collapsed}
                onToggleNavigation={() => {
                  setCollapsed(false);
                  setMobile(!mobile);
                }}
                active={view === "thread" && active === t.id}
                workEnabled={workPolicies[t.folder || "普通对话"] !== false}
                configurationCapability={(() => {
                  const a = agents.find((item) =>
                    selectionMatchesAgent(item, t),
                  );
                  if (!a || usesApi(t)) return undefined;
                  const models = currentModelOptions(a, {
                    access: "existing",
                    folder: t.folder,
                    serviceId: "",
                  });
                  return {
                    models: models.map((id) => ({
                      id,
                      label: id,
                      efforts: a.efforts || [],
                    })),
                    configOptions: additionalOptionsFor(a, t),
                    supportsModelChange: models.length > 1,
                    supportsEffortChange: Boolean(a.efforts?.length > 1),
                  };
                })()}
                agentPermissionCapability={permissionCapabilityFor(
                  agents.find((a) => selectionMatchesAgent(a, t)),
                )}
                onResumeSending={() =>
                  setWorkPolicies((p) => ({
                    ...p,
                    [t.folder || "普通对话"]: true,
                  }))
                }
                onTaskChange={(u) => patch(t.id, u)}
                toast={toast}
                onNew={() => {
                  if (t.importedLocationMissing) {
                    setLocationTask(t);
                    setNewLocation("");
                    setModal("import-location");
                    return;
                  }
                  startFromHistory(t);
                }}
                onSettings={(tab, request = {}) =>
                  t.accessTest && tab === "agents"
                    ? returnToPreparation(t.id)
                    : tab === "agents"
                      ? explore(
                          t.agentId || t.agent,
                          conversationPreparationRequest(t, request),
                        )
                      : openSettings(tab)
                }
                onAccessTestAction={(action, id) =>
                  setAgents((previous) => actOnAccessTest(previous, id, action))
                }
                onReturnToPreparation={() => returnToPreparation(t.id)}
                agentUnavailable={
                  !t.accessTest &&
                  !agents.some(
                    (a) =>
                      selectionMatchesAgent(a, t) &&
                      (a.connected || a.demoReady || a.setupComplete),
                  )
                }
                serviceMissing={!t.accessTest && Boolean(conversationIssue(t))}
                serviceIssue={t.accessTest ? null : conversationIssue(t)}
              />
            </div>
          ))}
          <WorkbenchSettings
            notificationPreferences={notificationPreferences}
            onNotificationPreferencesChange={saveNotificationPreferences}
            onOpenTask={(id) => {
              const task = snapshotNow.current.tasks.find(
                (item) => item.id === id,
              );
              if (task) open(task);
            }}
            {...{
              view,
              revision,
              settingsTab,
              setSettingsTab,
              openSettings,
              go,
              settingsOrigin,
              toast,
              tasks,
              agents,
              services,
              setServices,
              storageIssue,
              setModal,
              theme,
              setTheme,
              archiveDays,
              commitArchive,
              runArchive,
              setFilters,
            }}
          />
        </main>
      </div>
      <ImportConversations
        key={"import-" + revision}
        open={importOpen}
        agents={agents}
        tasks={tasks}
        initialAgent={importTarget}
        requestId={importRequest}
        onClose={() => setImportOpen(false)}
        onImport={(incoming) =>
          setTasks((existing) => mergeImportedTasks(existing, incoming))
        }
        onOpen={open}
        onExplore={prepareImportedAgent}
        onNew={newChat}
      />
      {toastText && (
        <div className="toast" role="status">
          <Check size={16} />
          {toastText}
        </div>
      )}
      {modal === "import-location" && locationTask && (
        <HistoryLocationDialog
          task={locationTask}
          {...{ newLocation, setNewLocation }}
          onClose={() => setModal(null)}
          onStart={startFromHistory}
        />
      )}
      {modal === "agent-draft" && pendingChoice && (
        <Modal
          title="保留这份未发草稿"
          onClose={() => {
            setModal(null);
            setPendingChoice(null);
          }}
        >
          <p>
            当前内容准备交给 {choice.agent}（{choice.model || "Agent 当前模型"}{" "}
            / {choice.effort || "默认"}）。 刚才准备的是 {pendingChoice.agent}（
            {pendingChoice.model || "Agent 当前模型"} /{" "}
            {pendingChoice.effort || "默认"}）。
            采用新选择会改变这份草稿的来源或设置；工作位置和内容由你决定保留。
          </p>
          <blockquote className="history-draft-preview">
            {draft || `${files.length} 个附件`}
          </blockquote>
          <div className="workbench-choice-actions">
            <Button
              onClick={() => {
                setPendingChoice(null);
                setModal(null);
                newChat();
              }}
            >
              返回原草稿
            </Button>
            <Button
              onClick={() => {
                setDraft("");
                setFiles([]);
                applyPreparedChoice(pendingChoice);
              }}
            >
              清空内容并新开
            </Button>
            <Button primary onClick={() => applyPreparedChoice(pendingChoice)}>
              保留内容并改用 {pendingChoice.agent}
            </Button>
          </div>
        </Modal>
      )}
      <WorkPolicyDialog
        {...{ modal, setModal, folder, tasks, workPolicies, setWorkPolicies }}
      />
      {historyStart && (
        <HistoryStartDialog
          request={historyStart}
          current={draftNow.current}
          agents={agents}
          services={services}
          onClose={() => setHistoryStart(null)}
          onApply={applyHistoryStart}
          error={historyStartError}
        />
      )}
      <LibraryDialogs
        {...{
          modal,
          setModal,
          search,
          setSearch,
          tasks,
          open,
          name,
          setName,
          groups,
          setGroups,
          renameId,
          patch,
          toast,
          moveIds,
        }}
      />
      {modal === "examples" && (
        <Modal
          title="载入示例？"
          onClose={() => setModal(null)}
          footer={
            <>
              <Button onClick={() => setModal(null)}>取消</Button>
              <Button primary onClick={() => reset(true)}>
                替换演示并载入
              </Button>
            </>
          }
        >
          <p>
            将替换当前演示数据，包括对话、草稿、Agent 接入进度、API
            设置、分组和发送管理，载入包含已连接 Agent 的示例。评审意见保留。
          </p>
          <p>
            载入后从“所有对话”查看代码、网页、文稿和运行结果；其他操作使用侧栏和页面中的正常入口。点击“重置演示”可回到首次打开。
          </p>
        </Modal>
      )}
      {modal === "reset" && (
        <Modal
          title="重置演示？"
          onClose={() => setModal(null)}
          footer={
            <>
              <Button onClick={() => setModal(null)}>取消</Button>
              <Button primary onClick={() => reset()}>
                重置演示
              </Button>
            </>
          }
        >
          <p>
            回到首次打开：清空演示对话、草稿和接入进度，所有 Agent
            重新从准备使用开始。评审意见保留，不影响正式 Farfold。
          </p>
        </Modal>
      )}
      {modal === "restore-attachments" && (
        <AttachmentRecoveryDialog
          files={files}
          onClose={() => setModal(null)}
          onConfirm={(kept) => {
            setFiles(kept);
            setAttachmentsNeedReview(false);
            setModal(null);
            toast("附件记录已核对，内容仍由你发送。");
          }}
        />
      )}
      {modal === "guide" && (
        <RedesignGuide
          onClose={() => setModal(null)}
          onNavigate={navigateReview}
        />
      )}
      <ReviewDialogs
        {...{
          modal,
          setModal,
          feedback,
          feedbackText,
          setFeedbackText,
          rating,
          setRating,
          exportFeedback,
          saveFeedback,
        }}
      />
    </div>
  );
}
