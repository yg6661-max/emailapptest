import React, { useState, useEffect } from "react";
import {
  Calendar,
  Mail,
  ArrowRight,
  Copy,
  Check,
  Settings,
  Trash2,
  Play,
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  ShieldCheck,
  LogOut,
  RefreshCw,
  Info,
  CornerUpLeft,
  BookOpen,
  Search,
  Plus,
  HelpCircle,
  FileText
} from "lucide-react";

import { formatShortSourceTitle } from "./utils";
import RAGWorkspace from "./components/RAGWorkspace";

interface StatusData {
  googleConnected: boolean;
  userEmail: string;
  clientIdConfigured: boolean;
  clientSecretConfigured: boolean;
  targetCalendarId: string;
  remainingTime: number;
}

interface HistoryItem {
  id: string;
  timestamp: string;
  subject: string;
  body: string;
  dateReceived: string;
  hasEvent: boolean;
  isReply?: boolean;
  aiSummary: {
    title: string;
    start_time: string;
    end_time: string;
    is_all_day: boolean;
    description: string;
    location?: string;
    reasoning: string;
  } | null;
  calendarEventId: string;
  calendarEventLink: string;
  status: "success" | "processing" | "retrying" | "pending_calendar" | "summary_only" | "failed" | "failed_calendar";
  errorMessage: string;
}

// Helper to parse JSON response safely only when Content-Type is application/json
const safeFetchJson = async (res: Response) => {
  if (!res.ok) return null;
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
};

export default function App() {
  // Config and Status state
  const [status, setStatus] = useState<StatusData>({
    googleConnected: false,
    userEmail: "",
    clientIdConfigured: false,
    clientSecretConfigured: false,
    targetCalendarId: "primary",
    remainingTime: 0
  });

  // Track the real-time countdown of the Google Access Token
  const [secondsLeft, setSecondsLeft] = useState<number>(0);

  // Sync status remainingTime changes to our secondsLeft state
  useEffect(() => {
    if (status.remainingTime !== undefined) {
      setSecondsLeft(status.remainingTime);
    }
  }, [status.remainingTime]);

  // Handle local countdown ticking
  useEffect(() => {
    if (secondsLeft <= 0) return;
    const interval = setInterval(() => {
      setSecondsLeft(prev => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [secondsLeft]);

  // Periodically poll /api/auth/status every 60 seconds to keep tokens alive and sync UI remaining time
  useEffect(() => {
    const interval = setInterval(() => {
      fetchStatus();
    }, 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Calendar list state
  const [calendars, setCalendars] = useState<Array<{ id: string; summary: string; primary: boolean }>>([]);
  const [loadingCalendars, setLoadingCalendars] = useState(false);

  // History state
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [retryingIds, setRetryingIds] = useState<Record<string, boolean>>({});

  // Forms state
  const [clientIdInput, setClientIdInput] = useState("");
  const [clientSecretInput, setClientSecretInput] = useState("");
  const [manualTokenInput, setManualTokenInput] = useState("");
  const [targetCalendarInput, setTargetCalendarInput] = useState("primary");

  // Manual Test tool fields
  const [testSubject, setTestSubject] = useState("Meeting setup on Monday at 3 PM");
  const [testBody, setTestBody] = useState(
    "Hi there, could we connect for our product review meeting next Monday (June 8) at 3:00 PM UTC? We can meet on Zoom at https://zoom.us/j/987654321. Let me know if that works!"
  );
  const [testDateReceived, setTestDateReceived] = useState(new Date().toISOString().substring(0, 16));
  const [testingWorkflow, setTestingWorkflow] = useState(false);

  // UI helpers
  const [copied, setCopied] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [showManualLogin, setShowManualLogin] = useState(false);
  const [authSuccessMsg, setAuthSuccessMsg] = useState("");

  // RAG / Knowledge Base states (NotebookLM integration)
  const [activeTab, setActiveTab] = useState<"dashboard" | "knowledge">("dashboard");
  const [knowledgeBase, setKnowledgeBase] = useState<any[]>([]);
  const [loadingKnowledge, setLoadingKnowledge] = useState(false);
  const [kbTitle, setKbTitle] = useState("");
  const [kbCategory, setKbCategory] = useState("Cumulus Linux");
  const [kbTags, setKbTags] = useState("");
  const [kbContent, setKbContent] = useState("");
  const [kbEditingId, setKbEditingId] = useState<string | null>(null);
  const [showKbForm, setShowKbForm] = useState(false);
  const [simQuery, setSimQuery] = useState("");
  const [simAnswer, setSimAnswer] = useState<any | null>(null);
  const [checkingSim, setCheckingSim] = useState(false);

  // Fetch private knowledge base
  const fetchKnowledgeBase = async () => {
    setLoadingKnowledge(true);
    try {
      const res = await fetch("/api/knowledge-base");
      const data = await safeFetchJson(res);
      if (data) {
        setKnowledgeBase(data.knowledgeBase || []);
      }
    } catch (e) {
      console.error("Error fetching knowledge base:", e);
    } finally {
      setLoadingKnowledge(false);
    }
  };

  useEffect(() => {
    fetchKnowledgeBase();
  }, []);

  // Save/Update Knowledge document
  const handleSaveKb = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!kbTitle || !kbContent) {
      alert("제목과 내용을 입력해 주세요.");
      return;
    }
    try {
      const res = await fetch("/api/knowledge-base", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: kbEditingId,
          title: kbTitle,
          category: kbCategory,
          tags: kbTags.split(",").map(t => t.trim()).filter(Boolean),
          content: kbContent
        })
      });
      if (res.ok) {
        alert(kbEditingId ? "문서가 수정되었습니다." : "새 지식 문서가 성공적으로 추가되었습니다.");
        setKbTitle("");
        setKbTags("");
        setKbContent("");
        setKbEditingId(null);
        setShowKbForm(false);
        fetchKnowledgeBase();
      } else {
        alert("지식 저장에 실패했습니다.");
      }
    } catch (err: any) {
      console.error(err);
      alert("오류 발생: " + err.message);
    }
  };

  // Delete Knowledge document
  const handleDeleteKb = async (id: string) => {
    if (!confirm("이 가이드 문서를 지식창고에서 완전히 삭제하시겠습니까? (삭제 시 AI가 이 내용을 참조할 수 없습니다)")) return;
    try {
      const res = await fetch("/api/knowledge-base/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      });
      if (res.ok) {
        fetchKnowledgeBase();
      }
    } catch (err: any) {
      console.error(err);
      alert("삭제 중 오류가 발생했습니다.");
    }
  };

  // Load template data to form
  const handleEditKb = (doc: any) => {
    setKbEditingId(doc.id);
    setKbTitle(doc.title);
    setKbCategory(doc.category);
    setKbTags((doc.tags || []).join(", "));
    setKbContent(doc.content);
    setShowKbForm(true);
  };

  // Interactive NotebookLM RAG simulated search from UI
  const handleSimulateRag = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!simQuery) return;
    setCheckingSim(true);
    setSimAnswer(null);
    try {
      const res = await fetch("/api/test-trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: `[사용자 직접질문] ${simQuery.substring(0, 30)}...`,
          body: simQuery,
          date_received: new Date().toISOString()
        })
      });
      if (res.ok) {
        let resData = await res.json();
        // 서버가 비동기로 접수한 경우: /api/history 를 폴링해 최종 결과를 가져온다 (최대 3분)
        if (resData && resData.async && resData.log && resData.log.id) {
          const logId = resData.log.id;
          const deadline = Date.now() + 180000;
          let finalEntry: any = null;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 2500));
            try {
              const hr = await fetch("/api/history");
              if (!hr.ok) continue;
              const hd = await hr.json();
              const entry = (hd.history || []).find((h: any) => h && h.id === logId);
              if (entry && (entry.aiSummary || entry.status === "failed")) { finalEntry = entry; break; }
            } catch {
              // keep polling
            }
          }
          resData = finalEntry
            ? { success: true, log: finalEntry }
            : { success: false, log: { status: "failed", errorMessage: "분석이 3분 내에 완료되지 않았습니다. 잠시 후 처리 이력에서 결과를 확인하세요." } };
        }
        if (resData.log && resData.log.aiSummary && resData.log.aiSummary.ragAnswer) {
          setSimAnswer(resData.log.aiSummary.ragAnswer);
          fetchHistory(); // Refresh history logs
        } else {
          setSimAnswer({
            triggered: false,
            answer: "지식 데이터베이스에서 유관 컨텍스트를 발견하지 못했거나 기술적인 질문이 아닙니다. 인피니밴드 NDR, ibstat, mstflint 혹은 큐물러스 LACP 본딩과 관련된 실제 상황을 질의해 주세요."
          });
        }
      } else {
        alert(`이메일 분석 RAG 테스트에 실패했습니다. (HTTP ${res.status})`);
      }
    } catch (err: any) {
      alert("네트워크 오류: " + err.message);
    } finally {
      setCheckingSim(false);
    }
  };

  // Poll history log states more aggressively (every 5 seconds) if any items are actively registering or retrying
  useEffect(() => {
    const hasActiveProcess = history.some(item => item.status === "processing" || item.status === "retrying");
    if (!hasActiveProcess) return;

    const interval = setInterval(() => {
      fetchHistory(true);
    }, 5 * 1000);

    return () => clearInterval(interval);
  }, [history]);

  const appUrl = window.location.origin;
  const webhookUrl = `${appUrl}/api/webhook`;

  // Fetch OAuth and connection status
  const fetchStatus = async () => {
    try {
      const res = await fetch("/api/auth/status");
      const data = await safeFetchJson(res);
      if (data) {
        setStatus(data);
        setTargetCalendarInput(data.targetCalendarId);
        if (data.googleConnected) {
          fetchCalendars();
          // Back up new / valid credentials to client's browser local storage
          if (data.backupCredentials) {
            localStorage.setItem("zapflow_google_creds", JSON.stringify({
              clientId: data.backupCredentials.clientId,
              clientSecret: data.backupCredentials.clientSecret,
              accessToken: data.backupCredentials.accessToken,
              refreshToken: data.backupCredentials.refreshToken,
              tokenExpiry: data.backupCredentials.tokenExpiry,
              userEmail: data.backupCredentials.userEmail,
              targetCalendarId: data.targetCalendarId
            }));
          }
        }
      }
    } catch (e) {
      console.error("Error fetching status:", e);
    }
  };

  // Fetch history logs
  const fetchHistory = async (silent = false) => {
    if (!silent) setLoadingHistory(true);
    try {
      const res = await fetch("/api/history");
      const data = await safeFetchJson(res);
      if (data) {
        setHistory(data.history || []);
      }
    } catch (e) {
      console.error("Error fetching history:", e);
    } finally {
      if (!silent) setLoadingHistory(false);
    }
  };

  // Fetch calendars list
  const fetchCalendars = async () => {
    setLoadingCalendars(true);
    try {
      const res = await fetch("/api/calendars");
      const data = await safeFetchJson(res);
      if (data) {
        setCalendars(data.calendars || []);
      }
    } catch (e) {
      console.error("Error fetching calendars:", e);
    } finally {
      setLoadingCalendars(false);
    }
  };

  // Triggered on page load/redirect check with Auto Sync & Restore from Browser Backup
  useEffect(() => {
    const initAndSync = async () => {
      try {
        const res = await fetch("/api/auth/status");
        const data = await safeFetchJson(res);
        if (data) {
          if (data.googleConnected) {
            setStatus(data);
            setTargetCalendarInput(data.targetCalendarId);
            fetchCalendars();
            // Store backup
            if (data.backupCredentials) {
              localStorage.setItem("zapflow_google_creds", JSON.stringify({
                clientId: data.backupCredentials.clientId,
                clientSecret: data.backupCredentials.clientSecret,
                accessToken: data.backupCredentials.accessToken,
                refreshToken: data.backupCredentials.refreshToken,
                tokenExpiry: data.backupCredentials.tokenExpiry,
                userEmail: data.backupCredentials.userEmail,
                targetCalendarId: data.targetCalendarId
              }));
            }
          } else {
            // Backend is not connected. Let's try to restore from localStorage if available!
            const savedStr = localStorage.getItem("zapflow_google_creds");
            if (savedStr) {
              try {
                const saved = JSON.parse(savedStr);
                if (saved.accessToken || (saved.clientId && saved.clientSecret)) {
                  console.log("Restoring Google connection backup from browser storage...");
                  const syncRes = await fetch("/api/auth/sync", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(saved)
                  });
                  if (syncRes.ok) {
                    const finalStatusRes = await fetch("/api/auth/status");
                    const finalData = await safeFetchJson(finalStatusRes);
                    if (finalData) {
                      setStatus(finalData);
                      setTargetCalendarInput(finalData.targetCalendarId);
                      if (finalData.googleConnected) {
                        fetchCalendars();
                      }
                      return;
                    }
                  }
                }
              } catch (err) {
                console.error("Failed to sync backup:", err);
              }
            }
            
            // Default update if sync didn't run or failed
            setStatus(data);
            setTargetCalendarInput(data.targetCalendarId);
          }
        }
      } catch (err) {
        console.error("Error during initial auth status fetch:", err);
      }
    };

    initAndSync();
    fetchHistory();

    // Check redirect status in URL
    const params = new URLSearchParams(window.location.search);
    const authStatus = params.get("auth_status");
    const errMsg = params.get("message");

    if (authStatus === "success") {
      setAuthSuccessMsg("Successfully connected to Google Calendar!");
      // Clean query parameter
      window.history.replaceState({}, document.title, window.location.pathname);
      initAndSync();
    } else if (authStatus === "error") {
      alert(`Connection failed: ${errMsg}`);
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  // Set default anchors based on received date state changes
  useEffect(() => {
    if (status.googleConnected && calendars.length === 0) {
      fetchCalendars();
    }
  }, [status.googleConnected]);

  // Listen for Google login success/failure messages from popups
  useEffect(() => {
    const handleOAuthMessage = (event: MessageEvent) => {
      const origin = event.origin;
      if (!origin.endsWith(".run.app") && !origin.includes("localhost")) {
        return;
      }
      
      if (event.data?.type === "OAUTH_AUTH_SUCCESS") {
        setAuthSuccessMsg("성공적으로 구글 캘린더에 연동되었습니다!");
        fetchStatus();
      } else if (event.data?.type === "OAUTH_AUTH_FAILED") {
        alert(`구글 로그인 실패: ${event.data.error || "알 수 없는 오류"}`);
      }
    };
    
    window.addEventListener("message", handleOAuthMessage);
    return () => window.removeEventListener("message", handleOAuthMessage);
  }, []);

  // Open Google Sign-In as a popup window to work perfectly in sandbox/iframe environment
  const handleGoogleLoginPopup = (e: React.MouseEvent) => {
    e.preventDefault();
    const width = 600;
    const height = 750;
    const left = window.screen.width / 2 - width / 2;
    const top = window.screen.height / 2 - height / 2;
    
    const popup = window.open(
      "/api/auth/google",
      "google_oauth_popup",
      `width=${width},height=${height},top=${top},left=${left},status=no,resizable=yes,scrollbars=yes`
    );
    
    if (!popup) {
      alert("브라우저 팝업이 차단되었습니다! 구글 로그인을 완료하기 위해 팝업 차단을 해제해 주세요.");
    }
  };

  // Copy webhook url to clipboard
  const copyToClipboard = () => {
    navigator.clipboard.writeText(webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Save server credentials
  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch("/api/auth/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: clientIdInput || undefined,
          clientSecret: clientSecretInput || undefined,
          targetCalendarId: targetCalendarInput
        })
      });
      if (res.ok) {
        alert("Configuration saved successfully!");
        setShowConfig(false);
        fetchStatus();
      }
    } catch (err) {
      console.error(err);
      alert("Failed to save credentials");
    }
  };

  // Reset custom credentials on server
  const handleResetConfig = async () => {
    if (!confirm("구글 API 콘솔에서 발급한 Client ID와 Client Secret 설정을 모두 초기화하시겠습니까? 초기화하면 기본 혹은 신규 설정이 가능해집니다.")) return;
    try {
      const res = await fetch("/api/auth/reset-credentials", { method: "POST" });
      if (res.ok) {
        alert("모든 맞춤 OAuth 설정이 공장 초기화되었습니다. 이제 새로운 인증키를 등록하실 수 있습니다.");
        localStorage.removeItem("zapflow_google_creds"); // Wipes client-side cache
        setClientIdInput("");
        setClientSecretInput("");
        setShowConfig(false);
        fetchStatus();
      }
    } catch (err) {
      console.error(err);
      alert("Failed to reset credentials");
    }
  };

  // Save manual token to authenticate without OAuth
  const handleSaveToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualTokenInput) return;
    try {
      const res = await fetch("/api/auth/save-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessToken: manualTokenInput,
          expires_in: 3600,
          userEmail: "manual-sandbox-user@google.com"
        })
      });
      if (res.ok) {
        setAuthSuccessMsg("Manually connected via token!");
        setShowManualLogin(false);
        setManualTokenInput("");
        fetchStatus();
      }
    } catch (err) {
      console.error(err);
      alert("Failed to validate manual token");
    }
  };

  // Clear google connection
  const handleLogoutGoogle = async () => {
    if (!confirm("Are you sure you want to disconnect Google Calendar? Webhooks will no longer automatically register calendar items.")) return;
    try {
      const res = await fetch("/api/auth/clear", { method: "POST" });
      if (res.ok) {
        localStorage.removeItem("zapflow_google_creds"); // Wipes client-side cache
        setStatus(prev => ({ ...prev, googleConnected: false, userEmail: "" }));
        setCalendars([]);
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Clear single or all history logs
  const handleDeleteHistory = async (id?: string) => {
    const isAll = !id;
    const confirmMsg = isAll 
      ? "Are you sure you want to clear ALL process logs? This cannot be undone." 
      : "Delete this log item?";
      
    if (!confirm(confirmMsg)) return;

    try {
      const res = await fetch("/api/history/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, clearAll: isAll })
      });
      if (res.ok) {
        if (isAll) {
          setHistory([]);
        } else {
          setHistory(prev => prev.filter(item => item.id !== id));
        }
      }
    } catch (e) {
      console.error("Delete history failed:", e);
    }
  };

  // Re-submit / Register a pending or failed log to Google Calendar
  const handleRetryLog = async (id: string) => {
    setRetryingIds(prev => ({ ...prev, [id]: true }));
    const parseJsonSafe = async (r: Response) => {
      const text = await r.text();
      try { return JSON.parse(text); } catch { return { error: `서버 응답이 JSON 이 아닙니다 (HTTP ${r.status}): ${text.substring(0, 120)}` }; }
    };
    try {
      const res = await fetch("/api/history/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      });

      const data = await parseJsonSafe(res);
      if (!res.ok || !data.success) {
        alert(`재전송 실패: ${data.error || "일시적인 오류가 발생했거나 연동이 중단되었습니다."}`);
        return;
      }

      if (!data.async) {
        alert("성공적으로 구글 캘린더에 일정을 등록했습니다!");
        fetchStatus();
        return;
      }

      // 비동기 처리: 이력을 폴링해 최종 상태를 확인 (최대 3분)
      const deadline = Date.now() + 180000;
      let finalEntry: any = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
          const hr = await fetch("/api/history");
          if (!hr.ok) continue;
          const hd = await parseJsonSafe(hr);
          const entry = (hd.history || []).find((h: any) => h && h.id === id);
          if (entry) {
            setHistory(hd.history || []);
            if (entry.status !== "processing" && entry.status !== "retrying") { finalEntry = entry; break; }
          }
        } catch {
          // keep polling
        }
      }

      if (!finalEntry) {
        alert("재처리가 아직 진행 중입니다. 잠시 후 처리 이력에서 결과를 확인하세요.");
      } else if (finalEntry.calendarEventId || finalEntry.status === "success" || finalEntry.status === "completed") {
        alert("성공적으로 구글 캘린더에 일정을 등록했습니다!");
        fetchStatus();
      } else {
        alert(`재전송 실패: ${finalEntry.errorMessage || finalEntry.status}`);
      }
    } catch (err: any) {
      console.error("Retry failed:", err);
      alert(`재전송 요청 실패: ${err.message || err}`);
    } finally {
      fetchHistory();
      setRetryingIds(prev => ({ ...prev, [id]: false }));
    }
  };

  // Run Manual Simulation Testing
  const handleTestTrigger = async (e: React.FormEvent) => {
    e.preventDefault();
    setTestingWorkflow(true);
    try {
      const res = await fetch("/api/test-trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: testSubject,
          body: testBody,
          date_received: new Date(testDateReceived).toISOString()
        })
      });
      if (res.ok) {
        fetchHistory();
        // Give a prompt
        const resData = await res.json();
        if (resData.log && resData.log.status === "success") {
          alert("Schedule mapped successfully! Check the event log below.");
        } else if (resData.log && resData.log.status === "pending_calendar") {
          alert("Parsed successfully! (Added to logs, but Google Calendar authentication is needed to book it)");
        } else {
          alert(`Workflow run completed: ${resData.log?.errorMessage || "Finished"}`);
        }
      } else {
        alert("Workflow processing failed.");
      }
    } catch (e: any) {
      alert(`Error running workflow: ${e.message}`);
    } finally {
      setTestingWorkflow(false);
    }
  };

  // Format Helper for timestamps
  const formatTime = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleString("ko-KR", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });
    } catch (e) {
      return isoString;
    }
  };

  // Format date received Korean
  const formatDateReceived = (isoString: string) => {
    try {
      const d = new Date(isoString);
      return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
    } catch {
      return isoString;
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-800 antialiased relative overflow-hidden">
      {/* Grid Background Effect from Professional Polish */}
      <div className="absolute inset-0 pointer-events-none z-0" style={{ backgroundImage: "radial-gradient(#cbd5e1 0.7px, transparent 0.7px)", backgroundSize: "24px 24px", opacity: 0.35 }}></div>

      {/* Sticky Premium Header Bar */}
      <header className="border-b border-slate-200 bg-white/90 backdrop-blur-md px-6 py-4 sticky top-0 z-50">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 relative z-10">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center text-white shadow-sm shadow-indigo-500/10 shrink-0">
              <Calendar className="h-5 w-5" id="app-brand-icon" />
            </div>
            <div>
              <h1 className="font-display text-lg font-bold tracking-tight text-slate-900">
                ZapFlow AI: Email to Calendar
              </h1>
              <p className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">
                Active Workflow • Scheduled Automations
              </p>
            </div>
          </div>
          
          <div className="flex items-center space-x-3">
            <span className="flex h-2 w-2 relative">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${status.googleConnected ? 'bg-emerald-400' : 'bg-rose-400'} opacity-75`}></span>
              <span className={`relative inline-flex rounded-full h-2 w-2 ${status.googleConnected ? 'bg-emerald-500' : 'bg-rose-500'} ${status.googleConnected ? 'shadow-[0_0_8px_#10b981]' : ''}`}></span>
            </span>
            <span className="text-xs font-semibold text-slate-600">
              {status.googleConnected ? "구글 캘린더 연동 활성화" : "구글 연동 대기중"}
            </span>
          </div>
        </div>
      </header>

      {/* Tab Switcher navigation */}
      <div className="bg-white border-b border-slate-200">
        <div className="mx-auto max-w-7xl px-4 lg:px-8">
          <div className="flex space-x-8">
            <button
              onClick={() => setActiveTab("dashboard")}
              className={`py-4 px-1 border-b-2 font-medium text-sm flex items-center space-x-2 cursor-pointer transition-all ${
                activeTab === "dashboard"
                  ? "border-indigo-600 text-indigo-600 font-bold"
                  : "border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300"
              }`}
            >
              <Calendar className="h-4 w-4" />
              <span>캘린더 및 이메일 연동 대시보드</span>
            </button>
            <button
              onClick={() => setActiveTab("knowledge")}
              className={`py-4 px-1 border-b-2 font-medium text-sm flex items-center space-x-2 cursor-pointer transition-all ${
                activeTab === "knowledge"
                  ? "border-indigo-600 text-indigo-600 font-bold"
                  : "border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300"
              }`}
            >
              <BookOpen className="h-4 w-4" />
              <span>RAG 지식창고 (NotebookLM 워크스페이스)</span>
              <span className="inline-flex items-center rounded-md bg-teal-50 px-1.5 py-0.5 text-xs font-semibold text-teal-705 ring-1 ring-inset ring-teal-600/10 shrink-0">
                인피니밴드 & 큐물러스
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* Main Responsive Layout */}
      <main className="mx-auto max-w-7xl px-4 py-8 lg:px-8 relative z-10">
        {activeTab === "dashboard" ? (
          <>
            {/* Banner with alerts */}
            {authSuccessMsg && (
          <div className="mb-6 flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50/80 backdrop-blur-xs p-4 text-emerald-800 shadow-sm animate-fade-in">
            <div className="flex items-center space-x-3">
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
              <span className="text-sm font-medium">{authSuccessMsg}</span>
            </div>
            <button 
              onClick={() => setAuthSuccessMsg("")} 
              className="rounded-lg p-1 text-emerald-500 hover:bg-emerald-100 transition-colors"
            >
              ✕
            </button>
          </div>
        )}

        {/* Dashboard 2-Column Grid */}
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
          
          {/* Column A: Setup, Connection, and Guides */}
          <div className="space-y-8 flex flex-col">
            
            {/* 1. Google connection Status Card */}
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between border-b border-slate-100 pb-4 mb-4">
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600">
                    <ShieldCheck className="h-4.5 w-4.5" />
                  </div>
                  <div>
                    <h2 className="font-display font-bold text-slate-900 text-sm">구글 캘린더 연동 설정</h2>
                    <p className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Google Calendar Status</p>
                  </div>
                </div>
                <div className="flex space-x-2">
                  <button
                    onClick={() => setShowManualLogin(!showManualLogin)}
                    className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 cursor-pointer transition-colors"
                  >
                    {showManualLogin ? "일반 설정" : "토큰으로 직접 로그인"}
                  </button>
                </div>
              </div>

              {!showManualLogin ? (
                <div>
                  {status.googleConnected ? (
                    <div>
                      <div className="rounded-xl bg-slate-50/80 p-4 border border-slate-150 mb-5">
                        <div className="flex items-center space-x-3 mb-2">
                          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-600 text-white font-semibold text-xs shadow-xs">
                            G
                          </div>
                          <div>
                            <p className="text-[10px] font-bold text-slate-400 font-mono uppercase tracking-wider">연동된 계정 (OAuth User)</p>
                            <p className="text-sm font-bold text-slate-800">{status.userEmail || "yg6661@gmail.com"}</p>
                          </div>
                        </div>
                        {secondsLeft > 0 ? (
                          <div className="flex flex-col space-y-2 mt-3">
                            <div className="flex items-center text-xs text-emerald-700 font-semibold bg-emerald-50/80 border border-emerald-200 rounded-xl py-2 px-3">
                              <Clock className="mr-1.5 h-3.5 w-3.5 animate-spin-slow text-emerald-500 shrink-0" />
                              인증 실시간 잔여 시간: {Math.floor(secondsLeft / 60)}분 {secondsLeft % 60}초 남음
                            </div>
                            <p className="text-[10px] text-slate-500 pl-1 leading-relaxed">
                              ※ <strong>자동 인증 연장 매크로(서버 데몬)</strong>가 항시 가동 중입니다. 만료 15분 전 자동으로 토큰이 무한 갱신되므로, 브라우저 창을 닫아두셔도 구글 캘린더 연동이 끊어지지 않고 평생 유지됩니다!
                            </p>
                          </div>
                        ) : (
                          <div className="flex flex-col space-y-2 mt-3">
                            <div className="flex items-start text-[11px] text-amber-700 font-medium bg-amber-50/85 border border-amber-200 rounded-xl py-2 px-3">
                              <AlertTriangle className="mr-1.5 h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
                              <div>
                                <span className="font-bold">임시 수동 토큰 작동 중 또는 토큰 만료 상태</span>
                                <p className="text-[10px] text-slate-500 mt-1 leading-relaxed">
                                  '토큰으로 직접 로그인' 하셨거나 Refresh Token이 유실된 상태입니다. 토큰 수명이 다하면 재연동이 어렵습니다. 평생 자동 갱신을 사용하시려면 아래에서 <span className="underline font-semibold">구글 간편 로그인(Sign in with Google)</span>을 완료해 주세요.
                                </p>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Calendar Select Section */}
                      <div className="mb-4">
                        <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                          등록할 대상 캘린더 선택 (Target Calendar)
                        </label>
                        {loadingCalendars ? (
                          <div className="flex items-center space-x-2 py-2">
                            <RefreshCw className="h-4 w-4 animate-spin text-indigo-500" />
                            <span className="text-xs text-slate-400">캘린더 목록을 가져오는 중...</span>
                          </div>
                        ) : (
                          <div className="flex gap-2">
                            <select
                                value={targetCalendarInput}
                                onChange={(e) => {
                                  setTargetCalendarInput(e.target.value);
                                  fetch("/api/auth/configure", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ targetCalendarId: e.target.value })
                                  }).then(() => fetchStatus());
                                }}
                                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium focus:border-indigo-500 focus:bg-white focus:outline-hidden focus:ring-2 focus:ring-indigo-150 transition-all text-slate-700"
                              >
                                <option value="primary">Primary Calendar (기본 캘린더)</option>
                                {calendars.map((cal) => (
                                  <option key={cal.id} value={cal.id}>
                                    {cal.summary} {cal.primary ? "(Primary)" : ""}
                                  </option>
                                ))}
                              </select>
                            <button
                              onClick={fetchCalendars}
                              title="캘린더 새로고침"
                              className="rounded-xl border border-slate-200 p-2 hover:bg-slate-50 text-slate-500 aspect-square flex items-center justify-center cursor-pointer transition-colors"
                            >
                              <RefreshCw className="h-4 w-4" />
                            </button>
                          </div>
                        )}
                      </div>

                      <div className="flex space-x-2 mt-4 pt-3 border-t border-slate-100">
                        <button
                          onClick={handleLogoutGoogle}
                          className="flex items-center justify-center space-x-2 w-full rounded-xl border border-red-100 bg-white py-2 px-4 text-sm font-semibold text-red-600 hover:bg-red-50 hover:text-red-700 transition-colors cursor-pointer"
                        >
                          <LogOut className="h-4 w-4" />
                          <span>연동 해제</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="rounded-xl bg-amber-50/80 p-4 border border-amber-100 mb-5 text-xs text-amber-900 leading-relaxed">
                        <div className="flex items-start space-x-2.5">
                          <AlertTriangle className="h-4.5 w-4.5 text-amber-500 shrink-0 mt-0.5" />
                          <div>
                            <span className="font-bold text-slate-800 block text-xs mb-0.5">구글 캘린더가 아직 연결되어 있지 않습니다.</span>
                            Zapier에서 전달받은 이메일은 Gemini AI로 요약 및 추출되나, 캘린더 등록을 위해서는 구글 계정 로그인이 필요합니다. 아래 버튼으로 연동을 완료해 주세요.
                          </div>
                        </div>
                      </div>

                      {/* Google Authentication Trigger Button */}
                      <div className="space-y-4">
                        <button
                          onClick={handleGoogleLoginPopup}
                          className="gsi-material-button w-full relative inline-flex items-center justify-center p-3 font-semibold text-slate-700 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 active:bg-slate-100 transition-all cursor-pointer shadow-3xs"
                        >
                          <div className="gsi-material-button-content-wrapper flex items-center justify-center space-x-3">
                            <div className="gsi-material-button-icon h-5 w-5">
                              <svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" style={{ display: "block" }}>
                                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"></path>
                                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"></path>
                                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"></path>
                                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"></path>
                              </svg>
                            </div>
                            <span className="gsi-material-button-contents font-display text-sm font-bold text-slate-800">Sign in with Google</span>
                          </div>
                        </button>

                        <div className="border-t border-slate-100 pt-3">
                          <button
                            onClick={() => setShowConfig(!showConfig)}
                            className="flex items-center text-xs font-semibold text-slate-400 hover:text-indigo-600 transition-colors"
                          >
                            <Settings className="mr-1 h-3.5 w-3.5" />
                            {showConfig ? "서버 Credential 설정 숨기기" : "OAuth Client ID 직접 입력하기..."}
                          </button>
                          
                          {showConfig && (
                            <form onSubmit={handleSaveConfig} className="bg-slate-50/80 border border-slate-200 rounded-xl p-4 mt-3 space-y-3 animate-fade-in text-xs">
                              <p className="text-[11px] text-slate-500 leading-relaxed font-sans">
                                <span className="font-bold text-slate-700">팁:</span> Google API Console에서 직접 생성한 OAuth 2.0 Web ID 와 Secret이 있는 경우 입력해 주세요. 미포함 시 서버에 설정된 임시 연동 설정을 기본 로드 합니다.
                              </p>
                              
                              <div className="bg-white/80 rounded-lg p-2 border border-slate-150 text-[10px] space-y-1 text-slate-600">
                                <span className="font-bold text-slate-700 block">※ Google API 콘솔 등록용 승인된 리디렉션 URI (Redirect URI):</span>
                                <div className="flex items-center justify-between gap-1.5 font-mono text-[9px] bg-slate-100 p-1.5 rounded-md border border-slate-200">
                                  <span className="truncate select-all">{window.location.origin + "/api/auth/google/callback"}</span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      navigator.clipboard.writeText(window.location.origin + "/api/auth/google/callback");
                                      alert("리디렉션 URI가 복사되었습니다!");
                                    }}
                                    className="px-1.5 py-0.5 bg-slate-200 hover:bg-slate-300 rounded text-slate-700 font-sans font-bold text-[9px] shrink-0 transition-all cursor-pointer"
                                  >
                                    복사
                                  </button>
                                </div>
                              </div>

                              <div>
                                <label className="block font-semibold text-slate-600 mb-1">Google Client ID</label>
                                <input
                                  type="text"
                                  value={clientIdInput}
                                  placeholder={status.clientIdConfigured ? "저장됨 (수정 시 여기 입력)" : "클라이언트 ID 입력"}
                                  onChange={(e) => setClientIdInput(e.target.value)}
                                  className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-150 focus:outline-hidden"
                                />
                              </div>
                              <div>
                                <label className="block font-semibold text-slate-600 mb-1">Google Client Secret</label>
                                <input
                                  type="password"
                                  value={clientSecretInput}
                                  placeholder={status.clientSecretConfigured ? "저장됨 (수정 시 여기 입력)" : "ID 시크릿 패스워드 입력"}
                                  onChange={(e) => setClientSecretInput(e.target.value)}
                                  className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-150 focus:outline-hidden"
                                />
                              </div>
                              <div className="flex gap-2">
                                <button
                                  type="submit"
                                  className="flex-1 rounded-lg bg-indigo-600 py-1.5 px-3 font-semibold text-white hover:bg-indigo-700 transition-colors shadow-2xs cursor-pointer"
                                >
                                  Credential 저장
                                </button>
                                {(status.clientIdConfigured || status.clientSecretConfigured) && (
                                  <button
                                    type="button"
                                    onClick={handleResetConfig}
                                    className="rounded-lg border border-red-200 bg-white hover:bg-red-50 text-red-600 py-1.5 px-3 font-semibold transition-colors cursor-pointer"
                                  >
                                    설정 초기화
                                  </button>
                                )}
                              </div>
                            </form>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <form onSubmit={handleSaveToken} className="space-y-4">
                  <div className="rounded-xl bg-slate-50 p-4 border border-slate-100 text-xs text-slate-600 space-y-2">
                    <span className="font-bold flex items-center text-slate-700 text-xs">
                      <Info className="h-4 w-4 mr-1 text-slate-450" />
                      Google Play 액세스 토큰 직접 로그인
                    </span>
                    <p className="leading-relaxed">
                      구글 OAuth 서비스 설정을 통하지 않고 OAuth Playground 등에서 발급 받은 Google OAuth <code className="bg-slate-200 px-1 py-0.5 rounded font-mono font-bold text-slate-800">access_token</code>을 복사하여 빠른 연동 테스트를 할 수 있습니다!
                    </p>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                      Access Token
                    </label>
                    <textarea
                      value={manualTokenInput}
                      onChange={(e) => setManualTokenInput(e.target.value)}
                      placeholder="ya29.a0Acf..."
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-mono focus:border-indigo-500 focus:bg-white focus:ring-2 focus:ring-indigo-150 focus:outline-hidden transition-all h-20"
                      required
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      className="w-full rounded-xl bg-indigo-600 text-white py-2 text-sm font-semibold hover:bg-indigo-700 cursor-pointer shadow-md shadow-indigo-600/15 transition-all"
                    >
                      토큰 인증 적용
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowManualLogin(false)}
                      className="rounded-xl border border-slate-200 bg-white py-2 px-3 text-sm font-semibold hover:bg-slate-50 transition-colors"
                    >
                      취소
                    </button>
                  </div>
                </form>
              )}
            </div>

            {/* 2. Webhook & Zapier Configuration card */}
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm flex-1 flex flex-col justify-between">
              <div>
                <div className="flex items-center space-x-3 border-b border-slate-100 pb-4 mb-4">
                  <div className="rounded-lg bg-orange-100 p-2 text-orange-600">
                    <Mail className="h-5 w-5" />
                  </div>
                  <div>
                    <h2 className="font-display font-bold text-slate-950">Zapier 웹훅 연동 전송 설정</h2>
                    <p className="text-xs text-slate-500">Zapier Incoming Webhook Settings</p>
                  </div>
                </div>

                {/* Webhook Copy Field */}
                <div className="mb-6">
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                    내 웹훅 수신 URL (Target Webhook URL)
                  </label>
                  <div className="flex items-center space-x-2 p-1 bg-slate-900 text-slate-100 rounded-xl overflow-hidden shadow-inner border border-slate-800">
                    <span className="flex-1 px-3 text-xs font-mono truncate select-all">{webhookUrl}</span>
                    <button
                      onClick={copyToClipboard}
                      className="rounded-lg bg-slate-800 hover:bg-slate-700 p-2 text-slate-100 cursor-pointer min-w-24 flex items-center justify-center space-x-1"
                    >
                      {copied ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-emerald-400" />
                          <span className="text-[11px] font-bold text-emerald-400">복사완료!</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" />
                          <span className="text-[11px] font-bold">URL 복사하기</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* Step Guide */}
                <div className="space-y-4 text-xs select-none">
                  <h3 className="font-bold text-slate-800 tracking-wide uppercase text-[11px]">Zapier 워크플로우 빌드 방법:</h3>
                  <ol className="relative border-l border-slate-200 pl-4 space-y-4">
                    <li className="relative">
                      <span className="absolute -left-[22px] flex h-4 w-4 items-center justify-center rounded-full bg-blue-100 text-[10px] font-black text-blue-600 border border-white">
                        1
                      </span>
                      <p className="font-semibold text-slate-900">Trigger: "New Email Received" 선택</p>
                      <p className="text-slate-500 mt-1">
                        Zapier에서 Gmail, Outlook 등의 연동 서비스를 켜고 새 이메일 수신 트리거를 생성합니다.
                      </p>
                    </li>
                    <li className="relative">
                      <span className="absolute -left-[22px] flex h-4 w-4 items-center justify-center rounded-full bg-blue-100 text-[10px] font-black text-blue-600 border border-white">
                        2
                      </span>
                      <p className="font-semibold text-slate-900">Action: "Webhooks by Zapier (POST)" 추가</p>
                      <p className="text-slate-500 mt-1">
                        Action으로 Webhook을 선택하고, 주소창에 <span className="font-semibold text-slate-800">위 복사된 웹훅 주소</span>를 붙여넣습니다.
                      </p>
                    </li>
                    <li className="relative">
                      <span className="absolute -left-[22px] flex h-4 w-4 items-center justify-center rounded-full bg-blue-100 text-[10px] font-black text-blue-600 border border-white">
                        3
                      </span>
                      <p className="font-semibold text-slate-900">Data Parameter 매핑 전송</p>
                      <p className="text-slate-500 mt-1">
                        데이터 형식은 <span className="font-semibold font-mono text-slate-800">JSON</span>으로 설정한 뒤 아래 키에 맞춰 이메일 요소를 매핑하여 발송합니다:
                      </p>
                      <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5 mt-2 font-mono text-[11px] text-slate-700 whitespace-pre">
                        {`{
  "subject": "{이메일 제목}",
  "body": "{이메일 본문 내용}",
  "date_received": "{이메일 수신 날짜 (선택)}"
}`}
                      </div>
                    </li>
                  </ol>
                </div>
              </div>
            </div>

          </div>

          {/* Column B: Manual Event Sandbox / Simulated Testing tool */}
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm flex flex-col justify-between h-full">
            <div className="flex flex-col h-full justify-between">
              <div>
                <div className="flex items-center space-x-3 border-b border-slate-100 pb-4 mb-4">
                  <div className="rounded-lg bg-indigo-100 p-2 text-indigo-600">
                    <Sparkles className="h-5 w-5" />
                  </div>
                  <div>
                    <h2 className="font-display font-bold text-slate-950">AI 워크플로우 샌드박스 테스터</h2>
                    <p className="text-xs text-slate-500">Manual Workflow Test Sandbox</p>
                  </div>
                </div>
                
                <p className="text-xs text-slate-500 mb-6 leading-relaxed">
                  Zapier 설정을 완료하기 전에, 이메일 수신 동작을 그대로 가상 시뮬레이션해볼 수 있습니다. 
                  메일의 내용에 일정이 기입되어 있을 때와 없을 때의 차이를 인공지능이 스스로 판단하여 캘린더 예약을 다르게 작성하는 신기한 지능형 프로세스를 확인해 보세요!
                </p>

                <form onSubmit={handleTestTrigger} className="space-y-4">
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                      이메일 제목 (Email Subject)
                    </label>
                    <input
                      type="text"
                      value={testSubject}
                      onChange={(e) => setTestSubject(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3/5 py-2.5 text-sm font-semibold focus:border-blue-500 focus:bg-white focus:outline-hidden transition-all"
                      placeholder="제목을 입력하세요..."
                      required
                    />
                  </div>

                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <label className="block text-xs font-bold uppercase tracking-wider text-slate-500">
                        이메일 본문 내용 (Email Body)
                      </label>
                      <div className="flex space-x-2 flex-wrap">
                        <button
                          type="button"
                          onClick={() => {
                            setTestSubject("[중요] 프로젝트 제안 컨설팅 미팅");
                            setTestBody(
                              "안녕하세요 오피스 컨설턴트 이민우입니다.\n다음 프로젝트 킥오프 미팅은 2026년 6월 12일 금요일 오전 10시 30분부터 정오 12시까지 서울 강남역 7번 출구 에스앤씨 타워 5층 미팅룸 B 실에서 개최할 예정입니다.\n프로토타입 도면과 노트북을 필수로 지참해 방문해 주세요.\n감사합니다."
                            );
                          }}
                          className="text-[10px] font-semibold text-blue-600 hover:underline cursor-pointer"
                        >
                          [예제 A: 일정이 있는 경우]
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setTestSubject("글로벌 신사업 브레인스토밍 아이디어 논의글");
                            setTestBody(
                              "팀장님, 안녕하세요. 기획실 홍길동 대리입니다.\n미팅 안건으로 논의되었던 미국 시장 진출을 위한 콘텐츠 비즈니스 아이디어를 3가지로 정리하여 공유합니다.\n1. 현지 인플루언서 숏폼 제작을 위한 크리에이터 전용 매니지먼트 얼라이언스 결성\n2. 오프라인 K-컬처 스트리밍 팝업 페스티벌 큐레이션\n3. 인바운드 투어 연동 한국어 전공자 프라이빗 데이 세미나 티켓 기획\n따로 시한을 잡아 면대면 논의를 잡지는 않았지만 미리 내용을 한번 요약하여 검토해봐 주셨으면 합니다. 감사합니다."
                            );
                          }}
                          className="text-[10px] font-semibold text-blue-600 hover:underline cursor-pointer"
                        >
                          [예제 B: 일정이 없는 경우]
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setTestSubject("Re: 다음주 기획 세미나 일정 조율의 건");
                            setTestBody(
                              "이 대리님, 안녕하세요.\n회신주신 기획 세미나 날짜 확인했습니다.\n제안하신 대로 다음주 화요일 (2026년 6월 16일) 오후 2시부터 4시까지 진행하는 방안으로 확정하여 참여하겠습니다.\n장소는 저희 본사 3층 컨퍼런스룸입니다.\n\n감사합니다.\n\n-----Original Message-----\nFrom: 이민수 대리 <mslee@company.com>\nSent: 2026-06-09 11:24 AM\nTo: 김진아 팀장 <jakim@partner.com>\nSubject: 다음주 기획 세미나 일정 조율의 건\n\n김 팀장님, 안녕하세요.\n다음주 기획 세미나 관련하여 혹시 2026년 6월 16일 화요일 오후 2시~4시 혹은 수요일 오전 10시~12시 중 언제 괜찮으실지 확인 부탁드립니다.\n감사합니다."
                            );
                          }}
                          className="text-[10px] font-semibold text-blue-600 hover:underline cursor-pointer"
                        >
                          [예제 C: 회신 메일 일정]
                        </button>
                      </div>
                    </div>
                    <textarea
                      value={testBody}
                      onChange={(e) => setTestBody(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm focus:border-blue-500 focus:bg-white focus:outline-hidden transition-all h-40 leading-relaxed font-sans"
                      placeholder="이메일의 상세 내용을 작성하세요..."
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                      이메일 가상 수신 시간 (Email Received Anchor Date)
                    </label>
                    <input
                      type="datetime-local"
                      value={testDateReceived}
                      onChange={(e) => setTestDateReceived(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm font-semibold focus:border-blue-500 focus:bg-white focus:outline-hidden transition-all"
                      required
                    />
                    <span className="text-[10px] text-slate-400 mt-1 block">
                      ※ "내일", "다음 주 화요일"과 같은 상대 시간을 이 날짜를 기준으로 추론합니다.
                    </span>
                  </div>
                </form>
              </div>

              <div className="pt-6 border-t border-slate-100 mt-6 font-display">
                <button
                  type="button"
                  onClick={handleTestTrigger}
                  disabled={testingWorkflow}
                  className="w-full relative inline-flex items-center justify-center p-4 text-base font-bold text-white bg-indigo-600 rounded-xl hover:bg-indigo-700 active:bg-indigo-800 disabled:bg-indigo-300 shadow-md shadow-indigo-600/15 cursor-pointer select-none transition-all"
                >
                  {testingWorkflow ? (
                    <div className="flex items-center space-x-2">
                      <RefreshCw className="h-5 w-5 animate-spin" />
                      <span>Gemini AI 분석 및 자동 스케줄 등록중...</span>
                    </div>
                  ) : (
                    <div className="flex items-center space-x-2">
                      <Play className="h-4 w-4 fill-white" />
                      <span>수신 시뮬레이션 및 분석 실행</span>
                    </div>
                  )}
                </button>
              </div>
            </div>
          </div>

        </div>

        {/* Bottom Section: Real-Time Process History logs */}
        <section className="mt-12 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 pb-4 mb-6">
            <div className="flex items-center space-x-3">
              <div className="rounded-lg bg-emerald-100 p-2 text-emerald-600">
                <Clock className="h-5 w-5" />
              </div>
              <div>
                <h2 className="font-display font-bold text-slate-950">워크플로우 수신 및 처리 기록 대장</h2>
                <p className="text-xs text-slate-500">Workflow Execution History</p>
              </div>
            </div>

            <div className="flex space-x-2 items-center">
              <button
                onClick={fetchHistory}
                disabled={loadingHistory}
                className="flex items-center space-x-1.5 rounded-lg border border-slate-200 bg-white p-2 text-slate-600 hover:bg-slate-50 disabled:opacity-50 transition-colors cursor-pointer text-xs font-semibold"
                title="기록 새로고침"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loadingHistory ? "animate-spin" : ""}`} />
                <span>기록 새로고침</span>
              </button>
              <button
                onClick={() => handleDeleteHistory()}
                disabled={history.length === 0}
                className="flex items-center justify-center space-x-1.5 rounded-lg border border-red-200 bg-white hover:bg-red-50 text-red-600 hover:text-red-700 py-1.5 px-3 text-xs font-semibold disabled:opacity-40 transition-all cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>처리 목록 전체삭제</span>
              </button>
            </div>
          </div>

          {/* Audit Logs Table / Empty state */}
          {loadingHistory && history.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-12 text-slate-400 space-y-3">
              <RefreshCw className="h-8 w-8 animate-spin text-indigo-500" />
              <span className="text-sm font-medium">처리 내역을 실시간 수집하는 중...</span>
            </div>
          ) : history.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center p-14 border border-dashed border-slate-200 rounded-xl bg-slate-50">
              <Mail className="h-10 w-10 text-slate-300 mb-3" />
              <h3 className="font-bold text-slate-700 text-sm">확인된 웹훅 통계가 없습니다</h3>
              <p className="text-xs text-slate-400 mt-1 max-w-md leading-relaxed">
                테스터의 시뮬레이션을 돌려보거나 실제 Zapier에서 webhook API를 타격하면 이곳에 인공지능이 분석을 거친 결과물이 생성되어 기록됩니다.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {history.map((log) => {
                const ai = log.aiSummary;
                return (
                  <div
                    key={log.id}
                    className="group border border-slate-200 hover:border-slate-300 rounded-xl overflow-hidden bg-white shadow-3xs hover:shadow-2xs transition-all relative"
                  >
                    {/* Top status header */}
                    <div className="border-b border-slate-100 bg-slate-50 group-hover:bg-slate-55 px-5 py-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex items-center space-x-3">
                        <span className="font-semibold text-slate-400 font-mono text-[11px] bg-white border border-slate-200 rounded-md py-0.5 px-2">
                          LOG ID: {log.id}
                        </span>
                        <span className="text-slate-500 font-medium">
                          시스템 수신일: {formatTime(log.timestamp)}
                        </span>
                      </div>
                      <div className="flex items-center space-x-2">
                        {/* AI Classification badge */}
                        {ai ? (
                          ai.has_event ? (
                            <span className="rounded-full bg-blue-100 text-blue-700 font-bold px-2.5 py-0.5 border border-blue-200 text-[10px]">
                              확정 일정 예약 (Event Captured)
                            </span>
                          ) : (
                            <span className="rounded-full bg-slate-100 text-slate-600 font-bold px-2.5 py-0.5 border border-slate-200 text-[10px]">
                              일정 미기입 (Mailing Summary)
                            </span>
                          )
                        ) : null}

                        {/* Calendar Status Badge */}
                        {log.status === "processing" && (
                          <span className="rounded-full bg-sky-100 text-sky-700 font-bold px-2.5 py-0.5 border border-sky-200 text-[10px] flex items-center animate-pulse gap-1">
                            <RefreshCw className="h-3 w-3 animate-spin text-sky-500" />
                            캘린더 등록 중...
                          </span>
                        )}
                        {log.status === "retrying" && (
                          <span className="rounded-full bg-indigo-100 text-indigo-700 font-extrabold px-2.5 py-0.5 border border-indigo-200 text-[10px] flex items-center animate-pulse gap-1">
                            <RefreshCw className="h-3 w-3 animate-spin text-indigo-500" />
                            예약 보완 재시도 중...
                          </span>
                        )}
                        {log.status === "success" && (
                          <span className="rounded-full bg-emerald-100 text-emerald-700 font-extrabold px-2.5 py-0.5 border border-emerald-200 text-[10px] flex items-center">
                            캘린더 등록 완료
                          </span>
                        )}
                        {log.status === "pending_calendar" && (
                          <span className="rounded-full bg-amber-100 text-amber-700 font-bold px-2.5 py-0.5 border border-amber-200 text-[10px] flex items-center">
                            대기 (연동 연결 필요)
                          </span>
                        )}
                        {log.status === "summary_only" && (
                          <span className="rounded-full bg-slate-100 text-slate-700 font-bold px-2.5 py-0.5 border border-slate-200 text-[10px] flex items-center">
                            ✉️ 일정 미포함 (요약 저장)
                          </span>
                        )}
                        {log.status.startsWith("failed") && (
                          <span className="rounded-full bg-rose-100 text-rose-700 font-bold px-2.5 py-0.5 border border-rose-200 text-[10px] flex items-center">
                            일시 오류 발생
                          </span>
                        )}

                        {/* Delete Log btn */}
                        <button
                          onClick={() => handleDeleteHistory(log.id)}
                          className="text-slate-400 hover:text-red-500 rounded p-1 hover:bg-slate-200 transition-colors ml-2"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Email Details and AI Analysis Grid inside details */}
                    <div className="p-5 grid grid-cols-1 md:grid-cols-12 gap-5">
                      
                      {/* Left Block: Original Email Meta */}
                      <div className="md:col-span-5 border-r border-slate-100 pr-0 md:pr-5">
                        <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">
                          원본 이메일 정보 (Raw Email Data)
                        </div>
                        <div className="space-y-2 text-xs">
                          <p className="font-bold text-slate-900 leading-snug flex items-start gap-1">
                            {log.isReply && (
                              <span className="inline-flex items-center shrink-0 bg-amber-100 text-amber-800 border border-amber-200 text-[10px] font-bold px-1.5 py-0.5 rounded">
                                <CornerUpLeft className="h-3 w-3 mr-0.5 shrink-0" />
                                회신
                              </span>
                            )}
                            <span>{log.subject}</span>
                          </p>
                          <div className="flex items-center text-[11px] text-slate-500 font-medium">
                            <span className="font-semibold text-slate-700 bg-slate-100 py-0.5 px-1 rounded mr-1">수신일 기준:</span> 
                            {formatDateReceived(log.dateReceived)}
                          </div>
                          <div className="border border-slate-100 rounded-lg p-2.5 bg-slate-50 text-[11px] max-h-32 overflow-y-auto whitespace-pre-wrap leading-relaxed text-slate-650 font-mono">
                            {log.body}
                          </div>
                        </div>
                      </div>

                      {/* Right Block: Gemini Parsing Engine Outcome */}
                      <div className="md:col-span-7 flex flex-col justify-between">
                        <div>
                          <div className="text-[11px] font-bold text-indigo-400 uppercase tracking-wider mb-2 flex items-center justify-between">
                            <span>Gemini AI 분석 정리 결과 (AI Output)</span>
                            <span className="text-[10px] text-slate-400 lowercase italic">powered by gemini-3.5-flash</span>
                          </div>
                          
                          {ai ? (
                            <div className="space-y-3">
                              {/* Calendar Event Schedule card summary */}
                              <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-4">
                                <div className="text-sm font-bold text-indigo-900 mb-1 flex items-center flex-wrap gap-1.5">
                                  <Sparkles className="h-4 w-4 mr-1 text-indigo-500 shrink-0" />
                                  <span>구글 캘린더 등록 제목: "{ai.title}"</span>
                                  {log.isReply && (
                                    <span className="inline-flex items-center bg-amber-100 text-amber-800 border border-amber-200 text-[10.5px] font-extrabold px-1.5 py-0.5 rounded">
                                      <CornerUpLeft className="h-2.5 w-2.5 mr-0.5 shrink-0" />
                                      회신 메일 분석
                                    </span>
                                  )}
                                </div>
                                <div className="text-xs text-slate-600 space-y-1.5 font-sans mt-2">
                                  <div className="flex items-baseline">
                                    <span className="font-bold text-slate-500 mr-2 min-w-16">일시:</span>
                                    <span className="font-semibold bg-white border border-slate-200 rounded py-0.5 px-1 text-slate-800 tracking-wide font-mono text-[11px]">
                                      {ai.is_all_day ? "하루 종일 일정 (All-day)" : `${formatTime(ai.start_time)} ~ ${formatTime(ai.end_time)}`}
                                    </span>
                                  </div>
                                  {ai.location && (
                                    <div className="flex items-baseline">
                                      <span className="font-bold text-slate-500 mr-2 min-w-16">장소:</span>
                                      <span className="font-medium text-slate-800 break-all">{ai.location}</span>
                                    </div>
                                  )}
                                  <div className="flex items-baseline">
                                    <span className="font-bold text-slate-500 mr-2 min-w-16">상세 요약:</span>
                                    <span className="text-slate-600 leading-relaxed font-sans block">
                                      {log.isReply && (
                                        <span className="inline-flex items-center bg-amber-50 text-amber-900 border border-amber-200 text-[9.5px] font-extrabold px-1.5 py-0.1 rounded mr-1.5 select-none">
                                          회신 요약
                                        </span>
                                      )}
                                      {ai.description}
                                    </span>
                                  </div>
                                </div>
                              </div>

                              {/* AI Reasoning line */}
                              <div className="text-[11px] text-slate-500 italic bg-slate-50 p-2.5 border border-slate-100 rounded-lg flex items-start">
                                <Info className="h-3.5 w-3.5 mr-1.5 text-slate-400 shrink-0 mt-0.5" />
                                <div>
                                  <strong>AI 추론 근거:</strong> {ai.reasoning}
                                </div>
                              </div>

                              {/* Technical RAG (NotebookLM) Lookup results */}
                              {ai.ragAnswer && (
                                <div className={`rounded-xl border p-4 mt-3 space-y-3 ${
                                  ai.ragAnswer.matchedSources && ai.ragAnswer.matchedSources.length > 0 && ai.ragAnswer.answer !== "RAG 검색 결과 관련 내용이 없습니다."
                                    ? "border-teal-200 bg-teal-50/40"
                                    : "border-slate-200 bg-slate-50/70"
                                }`}>
                                  <div className="text-xs font-bold flex items-center justify-between text-slate-800">
                                    <div className="flex items-center">
                                      <BookOpen className={`h-4 w-4 mr-1.5 shrink-0 ${
                                        ai.ragAnswer.matchedSources && ai.ragAnswer.matchedSources.length > 0 && ai.ragAnswer.answer !== "RAG 검색 결과 관련 내용이 없습니다."
                                          ? "text-teal-600"
                                          : "text-slate-500"
                                      }`} />
                                      <span>
                                        {ai.ragAnswer.matchedSources && ai.ragAnswer.matchedSources.length > 0 && ai.ragAnswer.answer !== "RAG 검색 결과 관련 내용이 없습니다."
                                          ? "로컬 지식창고 검색 결과 (RAG 매칭 완료)"
                                          : "로컬 지식창고 검색 결과 (RAG)"}
                                      </span>
                                    </div>
                                    <span className="font-mono text-[9px] bg-white text-slate-600 border border-slate-200 rounded px-1.5 py-0.5">
                                      NotebookLM Style
                                    </span>
                                  </div>

                                  <div className="text-xs text-slate-700 leading-relaxed whitespace-pre-wrap font-sans bg-white p-3 border border-slate-200 rounded-lg shadow-3xs">
                                    {ai.ragAnswer.answer || "RAG 검색 결과 관련 내용이 없습니다."}
                                  </div>

                                  {ai.ragAnswer.matchedSources && ai.ragAnswer.matchedSources.length > 0 && ai.ragAnswer.answer !== "RAG 검색 결과 관련 내용이 없습니다." && (
                                    <div className="text-[10px] text-slate-500 flex flex-wrap gap-1.5 items-center pt-0.5">
                                      <span className="font-semibold text-slate-500 flex items-center gap-1">
                                        <FileText className="h-3 w-3 text-teal-600" />
                                        출처:
                                      </span>
                                      {Array.from(new Set(ai.ragAnswer.matchedSources.map((s: string) => formatShortSourceTitle(s)))).map((source: string, idx: number) => (
                                        <span
                                          key={idx}
                                          className="bg-white text-teal-900 rounded border border-teal-200/80 px-2 py-0.5 font-medium text-[9.5px] shadow-3xs flex items-center gap-1"
                                          title={source}
                                        >
                                          <span className="h-1.5 w-1.5 rounded-full bg-teal-500 inline-block"></span>
                                          {source}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          ) : (
                            <p className="text-xs text-slate-400 italic">요약 결과물이 존재하지 않습니다.</p>
                          )}
                        </div>

                        {/* Calendar Link Panel if logged */}
                        <div className="border-t border-slate-150 pt-3 mt-4 flex flex-wrap items-center justify-between gap-3 text-xs">
                          <div className="flex-1">
                            {log.status === "success" && log.calendarEventLink ? (
                              <a
                                href={log.calendarEventLink}
                                target="_blank"
                                rel="noreferrer referrer"
                                className="inline-flex items-center space-x-1.5 font-bold text-blue-600 hover:text-blue-800 hover:underline cursor-pointer"
                              >
                                <span>구글 캘린더에서 내역 보기</span>
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            ) : log.status === "pending_calendar" ? (
                              <div className="flex items-center text-amber-600 font-semibold space-x-1">
                                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                <span>캘린더 미인증 상태: {status.googleConnected ? "연동이 확인되었습니다. 우측의 '캘린더에 바로 등록' 단추를 눌러주세요." : "위 'Google 로그인'을 완료하고 전송하세요."}</span>
                              </div>
                            ) : log.errorMessage ? (
                              <div className="flex items-center text-red-600 font-semibold space-x-1 pr-6 leading-normal">
                                <AlertTriangle className="h-4 w-4 shrink-0" />
                                <span>{log.errorMessage}</span>
                              </div>
                            ) : (
                              <span className="text-slate-455">프로세스 수집 완료</span>
                            )}
                          </div>

                          {/* Action Button to Resend / Retry */}
                          {log.status !== "success" && (
                            <button
                              onClick={() => handleRetryLog(log.id)}
                              disabled={retryingIds[log.id] || (log.status === "pending_calendar" && !status.googleConnected)}
                              className={`inline-flex items-center justify-center space-x-1.5 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                                log.status === "pending_calendar"
                                  ? "bg-indigo-600 hover:bg-indigo-700 text-white hover:shadow-xs shadow-indigo-100 disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none"
                                  : "bg-amber-600 hover:bg-amber-700 text-white shadow-xs"
                              }`}
                            >
                              {retryingIds[log.id] ? (
                                <>
                                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                  <span>등록 중...</span>
                                </>
                              ) : (
                                <>
                                  <RefreshCw className="h-3.5 w-3.5" />
                                  <span>{log.status === "pending_calendar" ? "캘린더에 바로 등록" : "다시 분석 및 전송"}</span>
                                </>
                              )}
                            </button>
                          )}
                        </div>

                      </div>

                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
          </>
        ) : (
          <RAGWorkspace onRefreshHistory={fetchHistory} />
        )}

      </main>

      <footer className="bg-slate-100 border-t border-slate-200 mt-20 py-8 px-6 text-center text-xs text-slate-400">
        <div className="mx-auto max-w-7xl">
          <p className="font-display font-medium text-slate-500 mb-1">Email Calendar Scheduler Dashboard</p>
          <p>© 2026. Custom Fullstack Agent Engine. Built selectively for Google Workspace Integrations.</p>
        </div>
      </footer>
    </div>
  );
}
