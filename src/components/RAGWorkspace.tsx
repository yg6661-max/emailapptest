import { formatShortSourceTitle } from "../utils";
import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  BookOpen,
  Sparkles,
  Play,
  RefreshCw,
  Plus,
  Trash2,
  Info,
  UploadCloud,
  FileText,
  CheckCircle,
  AlertTriangle,
  Globe
} from "lucide-react";

interface RAGWorkspaceProps {
  onRefreshHistory: () => void;
}

export default function RAGWorkspace({ onRefreshHistory }: RAGWorkspaceProps) {
  const [knowledgeBase, setKnowledgeBase] = useState<any[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [firestoreError, setFirestoreError] = useState<string | null>(null);
  
  // Doc fields
  const [kbTitle, setKbTitle] = useState("");
  const [kbCategory, setKbCategory] = useState("Cumulus Linux");
  const [kbTags, setKbTags] = useState("");
  const [kbContent, setKbContent] = useState("");
  const [kbEditingId, setKbEditingId] = useState<string | null>(null);
  const [showKbForm, setShowKbForm] = useState(false);

  // Search & Filter state for Knowledge documents
  const [searchQuery, setSearchQuery] = useState("");
  const [viewFilter, setViewFilter] = useState<"all" | "uploaded" | "default">("all");

  // QA Playground fields
  const [simQuery, setSimQuery] = useState("");
  const [simAnswer, setSimAnswer] = useState<any | null>(null);
  const [checkingSim, setCheckingSim] = useState(false);

  // Web crawling ingest state
  const [crawlUrl, setCrawlUrl] = useState("");
  const [crawlMaxPages, setCrawlMaxPages] = useState(10);
  const [crawlMaxDepth, setCrawlMaxDepth] = useState(2);
  const [crawlCategory, setCrawlCategory] = useState("Cumulus Linux");
  const [crawlingInProgress, setCrawlingInProgress] = useState(false);
  const [crawlLogs, setCrawlLogs] = useState<string[]>([]);
  const [sourceUrls, setSourceUrls] = useState<any[]>([]);
  const [retryingSync, setRetryingSync] = useState(false);

  // Retry Firestore sync
  const handleRetrySync = async () => {
    setRetryingSync(true);
    try {
      const res = await fetch("/api/knowledge-base/retry-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      const data = await res.json();
      setKnowledgeBase(data.knowledgeBase || []);
      setSourceUrls(data.sourceUrls || []);
      setFirestoreError(data.firestoreError || null);
      if (!data.firestoreError) {
        alert("Firestore 동기화에 성공했습니다! 클라우드 데이터베이스가 연결되어 상호작용 가능합니다.");
      } else {
        alert("동기화 시도 결과: " + data.firestoreError);
      }
    } catch (err: any) {
      alert("동기화 재시도 실패: " + err.message);
    } finally {
      setRetryingSync(false);
    }
  };

  // Fetch private knowledge base
  const fetchKnowledgeBase = async () => {
    setLoadingDocs(true);
    try {
      const res = await fetch("/api/knowledge-base");
      const contentType = res.headers.get("content-type") || "";
      if (res.ok && contentType.includes("application/json")) {
        const data = await res.json();
        setKnowledgeBase(data.knowledgeBase || []);
        setSourceUrls(data.sourceUrls || []);
        setFirestoreError(data.firestoreError || null);
      }
    } catch (e) {
      console.error("Error fetching knowledge base:", e);
    } finally {
      setLoadingDocs(false);
    }
  };

  // Helper to delete registered crawl URL source configuration
  const handleDeleteSource = async (id: string, deleteRelatedDocs: boolean) => {
    let confirmMsg = "등록된 크롤링 웹사이트 설정을 리스트에서 삭제하시겠습니까?";
    if (deleteRelatedDocs) {
      confirmMsg = "선택하신 웹사이트 설정 및 해당 호스트명에서 수집하여 색인한 모든 지식 가이드 문서를 일괄 삭제하시겠습니까? (되돌릴 수 없습니다)";
    }
    if (!confirm(confirmMsg)) return;

    try {
      const res = await fetch("/api/knowledge-base/sources/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, deleteDocs: deleteRelatedDocs }),
      });

      if (res.ok) {
        const data = await res.json();
        setSourceUrls(data.sourceUrls || []);
        if (deleteRelatedDocs) {
          alert(`삭제 성공! 총 ${data.deletedDocCount || 0}개의 연동 지식 가이드가 RAG 데이터베이스에서 완벽히 일괄 삭제되었습니다.`);
        } else {
          alert("웹사이트 설정 정보가 삭제되었습니다.");
        }
        await fetchKnowledgeBase();
      } else {
        alert("삭제 처리 중 에러가 발생했습니다.");
      }
    } catch (err: any) {
      alert("삭제 실패: " + err.message);
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
        alert(kbEditingId ? "가이드 문서가 정상적으로 수정되었습니다." : "새 지식 가이드 문서가 등록되었습니다.");
        setKbTitle("");
        setKbTags("");
        setKbContent("");
        setKbEditingId(null);
        setShowKbForm(false);
        fetchKnowledgeBase();
      } else {
        alert("지식 저장 중 오류가 발생했습니다.");
      }
    } catch (err: any) {
      console.error(err);
      alert("네트워크 오류가 발생했습니다: " + err.message);
    }
  };

  // Delete Knowledge document
  const handleDeleteKb = async (id: string) => {
    if (!confirm("이 가이드 문서를 지식창고에서 완전히 삭제하시겠습니까? (삭제 시 AI가 이 내용을 더 이상 참조하지 못합니다)")) return;
    try {
      const res = await fetch("/api/knowledge-base/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      });
      if (res.ok) {
        fetchKnowledgeBase();
      } else {
        alert("삭제 실패");
      }
    } catch (err: any) {
      console.error(err);
      alert("삭제 요청 중 네트워크 오류 발생");
    }
  };

  // Load template data to form for modifying
  const handleEditKb = (doc: any) => {
    setKbEditingId(doc.id);
    setKbTitle(doc.title);
    setKbCategory(doc.category || "Cumulus Linux");
    setKbTags((doc.tags || []).join(", "));
    setKbContent(doc.content);
    setShowKbForm(true);
  };

  // Interactive RAG simulated search
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
        const resData = await res.json();
        if (resData.log && resData.log.aiSummary && resData.log.aiSummary.ragAnswer) {
          setSimAnswer(resData.log.aiSummary.ragAnswer);
          onRefreshHistory(); // Refresh history log feed on main view in background
        } else {
          // Expose detail error message if backend processing failed (e.g. Gemini key missing, rate limits, firestore errors)
          const isFailedStatus = resData.log?.status === "failed";
          const failReason = resData.log?.errorMessage || "";
          
          setSimAnswer({
            triggered: false,
            answer: isFailedStatus && failReason
              ? `❌ AI 요약 및 RAG 시스템 작동 오류:\n\n${failReason}\n\n💡 조치방법: .env에 GEMINI_API_KEY 설정이 완비되어 있고 서비스가 정상 작동 중인지 확인하십시오.`
              : "지식베이스(사전 데이터)에서 관련 맥락을 찾지 못해 RAG가 작동하지 않았습니다. 큐물러스(LACP, MLAG, trunk, bridge) 혹은 인피니밴드(NDR, ibstat, mstflint) 기술 지식을 물어보세요."
          });
          onRefreshHistory();
        }
      } else {
        alert("이메일 분석 RAG 테스트에 실패했습니다.");
      }
    } catch (err: any) {
      alert("네트워크 통신 오류: " + err.message);
    } finally {
      setCheckingSim(false);
    }
  };

  // Unified reusable high-performance crawling process executor
  const runCrawlProcess = async (urlToCrawl: string, maxPages: number, maxDepth: number, category: string) => {
    setCrawlingInProgress(true);
    setCrawlLogs([]);

    try {
      const res = await fetch("/api/knowledge-base/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: urlToCrawl,
          maxPages,
          maxDepth,
          category,
        }),
      });

      if (!res.ok) {
        throw new Error(`웹 서버 연결 중 오류가 발생했습니다 (코드: ${res.status})`);
      }

      const reader = res.body?.getReader();
      if (!reader) {
        throw new Error("브라우저가 Streaming Reader를 지원하지 않습니다.");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the last partial line in the buffer
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;
          try {
            const data = JSON.parse(trimmed);
            if (data.message) {
              setCrawlLogs((prev) => [...prev, data.message]);
            }
            if (data.type === "start" || data.type === "saved" || data.type === "complete") {
              fetchKnowledgeBase();
            }
          } catch (err) {
            console.warn("Failed to parse crawler line chunk:", trimmed, err);
          }
        }
      }

      // If there's leftover buffer to parse after completing stream
      if (buffer.trim()) {
        try {
          const data = JSON.parse(buffer);
          if (data.message) {
            setCrawlLogs((prev) => [...prev, data.message]);
          }
        } catch (err) {
          // ignore
        }
      }

      // Refresh database to let the user see new documents automatically
      await fetchKnowledgeBase();
      onRefreshHistory();
    } catch (error: any) {
      console.error("Crawl error:", error);
      setCrawlLogs((prev) => [...prev, `🚨 크롤링 도중 오류가 발생했습니다: ${error.message || error}`]);
    } finally {
      setCrawlingInProgress(false);
    }
  };

  // Implement high-performance recursive website & child URL crawler
  const handleCrawlWebsite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!crawlUrl) return;
    await runCrawlProcess(crawlUrl, crawlMaxPages, crawlMaxDepth, crawlCategory);
  };

  // Counts
  const allCount = useMemo(() => knowledgeBase.length, [knowledgeBase]);
  const uploadedCount = useMemo(() => {
    return knowledgeBase.filter((doc: any) => 
      doc.title?.includes("[수동 업로드]") || 
      doc.title?.includes("[웹사이트]") || 
      doc.id?.startsWith("kb_crawl_")
    ).length;
  }, [knowledgeBase]);
  const defaultCount = useMemo(() => allCount - uploadedCount, [allCount, uploadedCount]);

  // Filtered list optimized with useMemo
  const filteredDocs = useMemo(() => {
    return knowledgeBase.filter((doc: any) => {
      const titleMatch = (doc.title || "").toLowerCase().includes(searchQuery.toLowerCase());
      const contentMatch = (doc.content || "").toLowerCase().includes(searchQuery.toLowerCase());
      const tagMatch = (doc.tags || []).some((t: string) => t.toLowerCase().includes(searchQuery.toLowerCase()));
      const matchesQuery = titleMatch || contentMatch || tagMatch;

      if (!matchesQuery) return false;

      const isUploaded = 
        (doc.title || "").includes("[수동 업로드]") || 
        (doc.title || "").includes("[웹사이트]") || 
        (doc.id || "").startsWith("kb_crawl_");
      if (viewFilter === "uploaded") {
        return isUploaded;
      }
      if (viewFilter === "default") {
        return !isUploaded;
      }
      return true; // "all"
    });
  }, [knowledgeBase, searchQuery, viewFilter]);

  return (
    <div className="space-y-8 animate-fade-in relative z-10">
      {/* 1. Header Information banner */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center space-x-3 mb-2">
          <div className="w-10 h-10 bg-teal-50 border border-teal-100 rounded-lg flex items-center justify-center text-teal-600 shrink-0">
            <BookOpen className="h-5 w-5" />
          </div>
          <div>
            <h2 className="font-display font-bold text-slate-950 text-base font-sans">NotebookLM 자동 연동 지식 시스템</h2>
            <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Retrieval-Augmented Generation (RAG) Workspace</p>
          </div>
        </div>
        <p className="text-xs text-slate-600 leading-relaxed mt-2.5 max-w-4xl">
          본 Workspace는 <strong>메일 요약 및 캘린더 등록 데몬</strong>과 정합성을 유지하며 실시간 자동 탐색합니다. 수신되는 메일에서 <strong>큐물러스 리눅스 (Cumulus Linux)</strong> 스위치 브릿지/본딩 설정 문의나 <strong>인피니밴드 (InfiniBand)</strong> HCA 어댑터 속도, GUID 식별, 포트 장애 점검 등 전문 하드웨어 인프라 질문이 인지되는 즉시 지식 창고를 탐색하여 완벽한 조치 정답을 추천 정리합니다.
        </p>
      </div>

      {/* Firestore Configuration Alert/Notice */}
      {firestoreError && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50/40 p-5 shadow-xs text-xs text-rose-950 leading-relaxed space-y-3.5 animate-fade-in">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center space-x-2 text-rose-850 font-extrabold text-sm">
              <span className="text-base">⚠️</span>
              <span>Firestore 클라우드 동기화 오프라인 상태 감지</span>
            </div>
            <button
              onClick={handleRetrySync}
              disabled={retryingSync}
              className="flex items-center space-x-1.5 bg-rose-600 hover:bg-rose-700 text-white font-bold text-[11px] px-3 py-1.5 rounded-lg shadow-2xs transition-all cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${retryingSync ? "animate-spin" : ""}`} />
              <span>{retryingSync ? "동기화 연결 중..." : "🔄 Firestore 연결 재시도"}</span>
            </button>
          </div>
          <p className="font-semibold text-rose-800 text-[11px] leading-relaxed">
            현재 개인 Firebase 프로젝트의 Firestore DB 저장 기능이 차단되거나 비활성화되어 있습니다.<br />
            오류 원인: <code className="bg-rose-100/85 text-rose-900 border border-rose-200 px-1.5 py-0.5 rounded font-mono text-[10px] break-all inline-block mt-1">{firestoreError}</code>
          </p>
          <div className="bg-white/95 border border-rose-100 rounded-xl p-4 space-y-2 text-[11.5px] text-slate-700 shadow-3xs">
            <span className="font-extrabold text-slate-900 block flex items-center">
              <span className="text-emerald-500 mr-1.5 font-bold">✓</span>
              수정 및 활성화 단계별 체크리스트:
            </span>
            <ul className="list-decimal list-inside space-y-2 font-medium text-slate-600 pl-1">
              <li>
                <strong className="text-slate-800">개인 Firebase Firestore 생성:</strong>
                <br />
                <span className="pl-4 inline-block text-slate-500 text-[10.5px]">
                  Firebase 콘솔(<a href="https://console.firebase.google.com" target="_blank" rel="noopener noreferrer" className="text-indigo-600 underline font-extrabold hover:text-indigo-800">console.firebase.google.com</a>) 접속 &gt; 빌드 &gt; Firestore Database에 들어가 데이터베이스가 활성화 상태인지 점검하세요.
                </span>
              </li>
              <li>
                <strong className="text-slate-800">보안 규칙 (Security Rules) 검증:</strong>
                <br />
                <span className="pl-4 inline-block text-slate-500 text-[10.5px]">
                  보안 규칙 탭에서 쓰기 권한(<code>allow read, write: if true;</code>)이 정상 배포되었는지 점검하세요. (AI Studio의 <span className="font-bold text-indigo-600">deploy_firebase</span> 도구가 이미 자동 배포를 시도했으나, 프로젝트 생성 전인 경우 수동 작성이 필요합니다)
                </span>
              </li>
              <li>
                <strong className="text-slate-800">자격 증명 동기화:</strong>
                <br />
                <span className="pl-4 inline-block text-slate-500 text-[10.5px]">
                  프로젝트 우측 상단의 <strong className="text-indigo-600">설정(Settings)</strong> 메뉴에서 개인 Firebase 연동 키가 최신 상태로 유지되고 있는지 점검하십시오.
                </span>
              </li>
            </ul>
          </div>
        </div>
      )}

      {/* 1-B. High Fidelity Interactive RAG Ingestion Card */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm animate-fade-in">
        <div className="flex flex-wrap items-center justify-between border-b border-slate-100 pb-3.5 mb-5 gap-3">
          <div className="flex items-center space-x-2">
            <Globe className="h-4.5 w-4.5 text-indigo-500" />
            <h3 className="font-display font-bold text-slate-900 text-sm">🌐 웹사이트 & 하위 URL 수집 (Crawler)</h3>
          </div>
        </div>

        {/* Web Crawler Module */}
        <form onSubmit={handleCrawlWebsite} className="space-y-4 animate-fade-in">
          <div className="rounded-xl bg-indigo-50/50 border border-indigo-150 p-4 mb-2">
            <p className="text-[11.5px] text-indigo-950 font-bold flex items-center mb-1">
              <Globe className="h-4 w-4 text-indigo-600 mr-1.5 blink-slow" />
              지능형 URL 크롤링 로봇 안내
            </p>
            <p className="text-[11px] text-indigo-750 font-sans leading-relaxed">
              특정 웹사이트 주소(예: 기술 가이드 허브, 위키피디아, 회사 FAQ 등)를 입력하면 크롤러가 <strong>첫 페이지뿐만 아니라 하위 URL(동일 도메인/Origin) 전체를 최대 레벨로 추적하여 RAG 지식 지형도로 일괄 가공</strong>합니다. 이메일 정밀 보조 AI가 이 기사들을 완벽히 참조하게 됩니다.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
            <div className="md:col-span-6">
              <label className="block text-[10.5px] font-bold text-slate-500 mb-1.5 uppercase tracking-wider">
                수집 대상 웹사이트 Root 주소 (URL)
              </label>
              <div className="relative">
                <input
                  type="text"
                  required
                  value={crawlUrl}
                  onChange={(e) => setCrawlUrl(e.target.value)}
                  placeholder="https://docs.nvidia.com/networking/ "
                  className="w-full rounded-xl border border-slate-250 bg-white pl-3 pr-4 py-2 text-xs focus:border-indigo-500 focus:ring-1 focus:ring-indigo-100 focus:outline-hidden text-slate-800 font-mono font-medium"
                />
              </div>
            </div>

            <div className="md:col-span-2">
              <label className="block text-[10.5px] font-bold text-slate-500 mb-1.5 uppercase tracking-wider">
                최대 수집 페이지 수
              </label>
              <select
                value={crawlMaxPages}
                onChange={(e) => setCrawlMaxPages(parseInt(e.target.value, 10))}
                className="w-full rounded-xl border border-slate-250 bg-white px-3 py-2 text-xs focus:border-indigo-555 focus:outline-hidden text-slate-705 font-bold"
              >
                <option value={5}>5 페이지</option>
                <option value={10}>10 페이지 (권장)</option>
                <option value={20}>20 페이지 (상세)</option>
                <option value={35}>35 페이지 (광범위)</option>
                <option value={50}>50 페이지 (최대)</option>
              </select>
            </div>

            <div className="md:col-span-2">
              <label className="block text-[10.5px] font-bold text-slate-500 mb-1.5 uppercase tracking-wider">
                추적 탐색 깊이 (Depth)
              </label>
              <select
                value={crawlMaxDepth}
                onChange={(e) => setCrawlMaxDepth(parseInt(e.target.value, 10))}
                className="w-full rounded-xl border border-slate-250 bg-white px-3 py-2 text-xs focus:border-indigo-555 focus:outline-hidden text-slate-705 font-bold"
              >
                <option value={1}>1단계 (입력 URL만 수집)</option>
                <option value={2}>2단계 (Default - 하위 첫째 링크까지)</option>
                <option value={3}>3단계 (하위 연결의 하위까지)</option>
                <option value={4}>4단계 (광역 재귀 탐색)</option>
              </select>
            </div>

            <div className="md:col-span-2">
              <label className="block text-[10.5px] font-bold text-slate-500 mb-1.5 uppercase tracking-wider">
                지정할 기술 카테고리
              </label>
              <select
                value={crawlCategory}
                onChange={(e) => setCrawlCategory(e.target.value)}
                className="w-full rounded-xl border border-slate-250 bg-white px-3 py-2 text-xs focus:border-indigo-555 focus:outline-hidden text-slate-705 font-bold"
              >
                <option value="Cumulus Linux">Cumulus Linux</option>
                <option value="InfiniBand">InfiniBand</option>
                <option value="Custom Crawled Web">기타 커스텀 웹 소스</option>
              </select>
            </div>
          </div>

          <div className="flex gap-3">
            <button
              type="submit"
              disabled={crawlingInProgress || !crawlUrl}
              className="flex-1 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2.5 px-4 text-xs transition-all shadow-md active:scale-[0.985] flex items-center justify-center space-x-2 cursor-pointer disabled:bg-indigo-300 disabled:scale-100 disabled:cursor-not-allowed font-sans"
            >
              {crawlingInProgress ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin text-white shrink-0 mr-1" />
                  <span>웹사이트 및 하위 URL 재귀 크롤링 작동 중...</span>
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4 text-white animate-pulse" />
                  <span>🕸️ 지능형 하위 링크 자동 크롤링 시작</span>
                </>
              )}
            </button>
          </div>

          {/* Advanced Live Terminal Console Logs */}
          {(crawlingInProgress || crawlLogs.length > 0) && (
            <div className="mt-3 space-y-2 animate-fade-in">
              <div className="flex items-center justify-between animate-fade-in">
                <span className="text-[10.5px] font-bold text-slate-500 flex items-center">
                  <RefreshCw className={`h-3 w-3 mr-1 text-indigo-500 ${crawlingInProgress ? "animate-spin" : ""}`} />
                  실시간 크롤링 로봇 터미널 로그 (Terminal Logs)
                </span>
                {crawlLogs.length > 0 && !crawlingInProgress && (
                  <button
                    type="button"
                    onClick={() => setCrawlLogs([])}
                    className="text-slate-400 hover:text-slate-600 text-[10px] font-bold transition-all"
                  >
                    로그 비우기 ✕
                  </button>
                )}
              </div>
              
              <div className="bg-slate-950 border border-slate-900 shadow-inner rounded-xl p-4 font-mono text-[10.5px] text-emerald-400 max-h-56 overflow-y-auto space-y-1.5 scrollbar-thin select-all">
                {crawlLogs.map((log, index) => (
                  <div key={index} className="leading-relaxed flex items-start">
                    <span className="text-slate-500 shrink-0 select-none mr-2">[{index + 1}]</span>
                    <span className="whitespace-pre-wrap">{log}</span>
                  </div>
                ))}
                {crawlingInProgress && (
                  <div className="flex items-center text-indigo-400 font-bold italic animate-pulse-slow mt-2 pl-6">
                    <span className="mr-1.5">●</span>
                    <span>로봇이 하위 하이퍼링크를 파싱하여 재귀 버퍼에 로딩하고 있습니다...</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Registered Source URLs Section */}
          <div className="mt-8 pt-6 border-t border-slate-200/80">
            <div className="flex flex-wrap items-center justify-between mb-4 gap-2">
              <div>
                <h4 className="text-xs font-bold text-slate-900 flex items-center space-x-1.5">
                  <Globe className="h-4 w-4 text-emerald-600 shrink-0" />
                  <span>📂 수집 및 연동된 웹사이트 소스 목록</span>
                </h4>
                <p className="text-[10px] text-slate-500 font-semibold mt-0.5">
                  수집한 웹 주소는 클라우드 데이터베이스에 자동 보관 및 영구 유지됩니다. 언제든지 원클릭 재수집 및 일괄 정리가 제공됩니다.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center space-x-1.5 px-2 py-0.5 rounded-full text-[9px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                  <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-ping shrink-0" />
                  <span>🔄 3일 주기 자동 갱신 가동 중</span>
                </span>
                <span className="text-[10px] font-mono font-bold bg-slate-100 text-slate-600 rounded-md px-2 py-0.5 border border-slate-200">
                  총 {sourceUrls.length}개 소스 등록됨
                </span>
              </div>
            </div>

            {sourceUrls.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center bg-slate-50/40">
                <Globe className="h-7 w-7 text-slate-300 mx-auto mb-2" />
                <p className="text-xs text-slate-400 font-semibold">아직 연동 유지된 RAG 웹사이트 소스가 없습니다.</p>
                <p className="text-[10px] text-slate-400 mt-1">상단 입력폼에서 첫 크롤링을 완료하면 이곳에 자동으로 영구 보관됩니다.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {sourceUrls.map((item) => (
                  <div key={item.id} className="rounded-xl border border-slate-200/85 bg-slate-50/50 p-4 hover:bg-slate-50 transition-all flex flex-col justify-between">
                    <div className="space-y-2">
                      <div className="flex items-start justify-between">
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[9.5px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-100">
                          {item.category}
                        </span>
                        <span className="text-[10px] font-mono text-slate-500 font-semibold">
                          {item.lastCrawledAt ? `마지막 수집: ${new Date(item.lastCrawledAt).toLocaleDateString()}` : "수집 전"}
                        </span>
                      </div>

                      <div className="mt-2.5 flex items-center space-x-1.5 text-[9.5px] font-semibold text-indigo-600 bg-indigo-50/60 border border-indigo-100 px-2 py-1 rounded-md">
                        <span className="w-1.2 h-1.2 bg-indigo-500 rounded-full animate-pulse shrink-0" />
                        <span>3일 주기 자동 동기화 & 실시간 자가 치유(Self-Healing) 활성화</span>
                      </div>

                      <div>
                        <a 
                          href={item.url} 
                          target="_blank" 
                          rel="noopener noreferrer" 
                          className="text-xs font-bold text-slate-800 hover:text-indigo-600 hover:underline break-all block leading-tight"
                        >
                          {item.url}
                        </a>
                      </div>

                      <div className="flex items-center space-x-3 text-[10.5px] text-slate-500 font-sans font-medium">
                        <span className="bg-white px-1.5 py-0.5 rounded border border-slate-150">최대 {item.maxPages}p</span>
                        <span className="bg-white px-1.5 py-0.5 rounded border border-slate-150">탐색 깊이 {item.maxDepth}</span>
                        <span className="font-bold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-100">
                          색인 문서: {item.count || 0}개
                        </span>
                      </div>
                    </div>

                    {/* 세부 색인 문서 목록 카드 뷰 (즉시 조회/편집) */}
                    {(() => {
                      const crawledDocsForSource = knowledgeBase.filter((doc: any) => {
                        if (!doc.id || !doc.id.startsWith("kb_crawl_")) return false;
                        
                        if (doc.sourceUrl) {
                          const cleanDocUrl = doc.sourceUrl.toLowerCase().trim().replace(/\/+$/, "");
                          const cleanSrcUrl = item.url.toLowerCase().trim().replace(/\/+$/, "");
                          if (cleanDocUrl.startsWith(cleanSrcUrl) || cleanDocUrl === cleanSrcUrl || cleanSrcUrl.startsWith(cleanDocUrl)) {
                            return true;
                          }
                        }
                        
                        if (doc.content) {
                          const match = doc.content.match(/\[출처 URL: ([^\]]+)\]/);
                          if (match && match[1]) {
                            const cleanContentUrl = match[1].toLowerCase().trim().replace(/\/+$/, "");
                            const cleanSrcUrl = item.url.toLowerCase().trim().replace(/\/+$/, "");
                            return cleanContentUrl.startsWith(cleanSrcUrl) || cleanContentUrl === cleanSrcUrl || cleanSrcUrl.startsWith(cleanContentUrl);
                          }
                        }
                        
                        return false;
                      });

                      if (crawledDocsForSource.length === 0) return null;

                      return (
                        <div className="mt-4 pt-3 border-t border-slate-200/50 space-y-2">
                          <div className="text-[10px] font-extrabold text-indigo-900/80 uppercase tracking-wide flex items-center justify-between">
                            <span>📁 수집색인된 세부 문서 ({crawledDocsForSource.length}개)</span>
                            <span className="text-[9px] text-emerald-600 bg-emerald-100/50 px-1.5 py-0.5 rounded animate-pulse">실시간 RAG 작동 중</span>
                          </div>
                          <div className="grid grid-cols-1 gap-2 max-h-56 overflow-y-auto pr-1 scrollbar-thin">
                            {crawledDocsForSource.map((doc: any) => (
                              <div key={doc.id} className="rounded-lg border border-slate-200 bg-white p-2.5 hover:shadow-3xs hover:border-indigo-300 transition-all flex flex-col justify-between">
                                <div>
                                  <div className="flex items-start justify-between gap-1">
                                    <h5 className="text-[11px] font-bold text-slate-800 leading-snug line-clamp-2" title={doc.title}>
                                      {doc.title.replace(/^\[웹사이트\]\s*/, "")}
                                    </h5>
                                    <div className="flex space-x-1 shrink-0">
                                      <button
                                        type="button"
                                        onClick={() => handleEditKb(doc)}
                                        className="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-605 font-bold transition-all cursor-pointer"
                                      >
                                        수정
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handleDeleteKb(doc.id)}
                                        className="text-[9px] px-1.5 py-0.5 rounded bg-rose-50 hover:bg-rose-100 text-rose-606 font-bold transition-all cursor-pointer"
                                      >
                                        삭제
                                      </button>
                                    </div>
                                  </div>

                                  {/* 자동 생성/부여된 RAG 태그셋 표기 */}
                                  {doc.tags && doc.tags.length > 0 && (
                                    <div className="flex flex-wrap gap-1 mt-1">
                                      {doc.tags.map((tag: string, tid: number) => (
                                        <span key={tid} className="text-[8.5px] font-semibold bg-indigo-50 text-indigo-600 px-1 py-0.2 rounded border border-indigo-100/50">
                                          #{tag}
                                        </span>
                                      ))}
                                    </div>
                                  )}

                                  <p className="text-[10px] text-slate-500 line-clamp-3 mt-1.5 leading-relaxed whitespace-pre-wrap">
                                    {doc.content.replace(/^\[출처 URL:[^\]]+\]\s+\[크롤링 수준:[^\]]+\]\s+/, "").trim()}
                                  </p>
                                </div>

                                <div className="flex items-center justify-between text-[9px] text-slate-400 mt-2 pt-1.5 border-t border-slate-105 border-dashed">
                                  <span className="truncate max-w-[170px]" title={doc.sourceUrl}>{doc.sourceUrl || item.url}</span>
                                  <span className="font-mono bg-slate-50 text-slate-500 px-1 py-0.3 rounded">
                                    {(doc.content ? doc.content.length : 0).toLocaleString()}자
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}

                      <div className="mt-4 pt-3 border-t border-slate-200/60 flex flex-wrap gap-2 items-center justify-between">
                        <div className="flex gap-1.5">
                          {/* Sync / Recrawl */}
                          <button
                            type="button"
                            onClick={() => {
                              setCrawlUrl(item.url);
                              setCrawlMaxPages(item.maxPages || 10);
                              setCrawlMaxDepth(item.maxDepth || 2);
                              setCrawlCategory(item.category || "Cumulus Linux");
                              runCrawlProcess(item.url, item.maxPages || 10, item.maxDepth || 2, item.category || "Cumulus Linux");
                            }}
                            disabled={crawlingInProgress}
                            className="inline-flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-[10.5px] font-bold bg-indigo-600 hover:bg-indigo-700 text-white transition-all disabled:bg-indigo-305 cursor-pointer shadow-3xs"
                          >
                            <RefreshCw className={`h-3 w-3 ${crawlingInProgress ? "animate-spin" : ""}`} />
                            <span>최신 재수집</span>
                          </button>

                          {/* Populate fields to tweak */}
                          <button
                            type="button"
                            onClick={() => {
                              setCrawlUrl(item.url);
                              setCrawlMaxPages(item.maxPages || 10);
                              setCrawlMaxDepth(item.maxDepth || 2);
                              setCrawlCategory(item.category || "Cumulus Linux");
                            }}
                            className="inline-flex items-center px-2.5 py-1.5 rounded-lg text-[10.5px] font-bold bg-white hover:bg-slate-100 text-slate-605 border border-slate-200 transition-all cursor-pointer shadow-3xs"
                          >
                            <span>설정 로드</span>
                          </button>
                        </div>

                        <div className="flex gap-1.5">
                          {/* Delete Config only */}
                          <button
                            type="button"
                            title="리스트 설정만 삭제 (수집된 문서는 보관함에 유지)"
                            onClick={() => handleDeleteSource(item.id, false)}
                            className="p-1 px-2 text-slate-500 hover:text-slate-700 rounded-lg hover:bg-slate-100 transition-all cursor-pointer text-[10.5px] font-bold border border-slate-200"
                          >
                            <span>설정 삭제</span>
                          </button>
                          
                          {/* Delete Source & Documents completely */}
                          <button
                            type="button"
                            title="설정 및 수집된 모든 파일 파괴"
                            onClick={() => handleDeleteSource(item.id, true)}
                            className="p-1 px-2 text-rose-600 hover:text-rose-800 rounded-lg hover:bg-rose-50 transition-all cursor-pointer text-[10.5px] font-bold border border-rose-200 flex items-center space-x-1"
                          >
                            <Trash2 className="h-3 w-3" />
                            <span>일괄 파괴</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </form>
      </div>

      {/* 2. Side-By-Side Layout */}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
        
        {/* Playbook Playground */}
        <div className="lg:col-span-5 space-y-6">
          <div className="rounded-2xl border border-teal-200/80 bg-white p-6 shadow-sm relative overflow-hidden">
            <div className="absolute top-0 right-0 w-32 h-32 bg-teal-50 rounded-full blur-3xl opacity-60"></div>
            
            <div className="flex items-center space-x-2 border-b border-slate-100 pb-3.5 mb-4 relative z-10">
              <Sparkles className="h-4.5 w-4.5 text-teal-600 animate-pulse" />
              <h3 className="font-display font-bold text-slate-900 text-sm">RAG 지식 검증 놀이터 (Playground)</h3>
            </div>

            <p className="text-[11px] text-slate-500 mb-4 leading-relaxed">
              등록된 기술 매뉴얼을 근간으로 하여 실시간 지식 추출 기능(Search Integration)을 작동시킵니다.
            </p>

            <form onSubmit={handleSimulateRag} className="space-y-4 relative z-10">
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">
                  질문 내용 (Technical Query)
                </label>
                <textarea
                  value={simQuery}
                  onChange={(e) => setSimQuery(e.target.value)}
                  placeholder="예: 큐물러스 리눅스 스위치에서 LACP 본딩 인터페이스 패킷 누수가 있을 때 MLAG 상태 조회법"
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-xs focus:border-teal-500 focus:bg-white focus:ring-1 focus:ring-teal-100 focus:outline-hidden transition-all h-28 font-sans leading-relaxed text-slate-700 placeholder:text-slate-400"
                  required
                />
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setSimQuery("인피니밴드 NDR 환경에서 어플라이언스 어댑터 GUID를 파악하고 HCA 물리 링크 연결 속도를 확인하는 명령어를 나열해 줄 수 있어?")}
                  className="rounded bg-slate-100 border border-slate-200 text-[10px] py-1 px-2 text-slate-600 hover:bg-slate-150 transition-colors cursor-pointer font-medium"
                >
                  💡 인피니밴드 HCA 속도/GUID 질의
                </button>
                <button
                  type="button"
                  onClick={() => setSimQuery("큐물러스 리눅스 vlan-aware 브릿지 설정에서 VLAN ID 10번 대역을 Trunk로 허용하기 위한 interfaces 파일 예시 구문을 알려줘.")}
                  className="rounded bg-slate-100 border border-slate-200 text-[10px] py-1 px-2 text-slate-600 hover:bg-slate-150 transition-colors cursor-pointer font-medium"
                >
                  💡 Trunk 브릿지 세팅 예문
                </button>
              </div>

              <button
                type="submit"
                disabled={checkingSim}
                className="w-full rounded-xl bg-teal-600 hover:bg-teal-700 text-white py-2.5 text-xs font-bold transition-all shadow-md shadow-teal-500/10 cursor-pointer disabled:bg-teal-300 flex items-center justify-center space-x-1.5"
              >
                {checkingSim ? (
                  <>
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    <span>로컬 지식창고 RAG 룩업 실행 중...</span>
                  </>
                ) : (
                  <>
                    <Play className="h-3.5 w-3.5" />
                    <span>질문 조회 및 스마트 분석</span>
                  </>
                )}
              </button>
            </form>

            {simAnswer && (
              <div className="mt-5 border-t border-slate-100 pt-5 space-y-4 font-sans animate-fade-in relative z-10">
                <div className="rounded-xl border border-teal-100 bg-teal-50/20 p-4 space-y-3 shadow-3xs">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-extrabold text-teal-950 flex items-center">
                      <Sparkles className="h-3.5 w-3.5 mr-1 text-teal-600 shrink-0" />
                      RAG 응답 검색 결과
                    </span>
                    <span className="text-[9px] uppercase tracking-wider bg-teal-100 text-teal-800 px-1.5 py-0.5 rounded font-bold">
                      Resolved
                    </span>
                  </div>

                  <div className="text-xs text-slate-750 whitespace-pre-wrap leading-relaxed bg-white/95 p-3 border border-teal-100/50 rounded-lg shadow-3xs font-mono select-all">
                    {simAnswer.answer}
                  </div>

                  {simAnswer.matchedSources && simAnswer.matchedSources.length > 0 && (
                    <div className="text-[10px] text-slate-500 space-y-1.5 pt-1">
                      <div className="font-semibold text-slate-500 flex items-center gap-1">
                        <FileText className="h-3 w-3 text-teal-600" />
                        출처:
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {Array.from(new Set(simAnswer.matchedSources.map((s: string) => formatShortSourceTitle(s)))).map((s: string, idx: number) => (
                           <span
                             key={idx}
                             className="bg-white border border-teal-200/80 text-teal-900 font-medium px-2 py-0.5 rounded text-[9.5px] shadow-3xs flex items-center gap-1"
                             title={s}
                           >
                             <span className="h-1.5 w-1.5 rounded-full bg-teal-500 inline-block"></span>
                             {s}
                           </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Directory/CRUD Table */}
        <div className="lg:col-span-7 space-y-6">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 pb-4 mb-4">
              <div>
                <h3 className="font-display font-bold text-slate-900 text-sm flex items-center">
                  <BookOpen className="h-4.5 w-4.5 mr-1.5 text-indigo-500" />
                  엔지니어링 지식 가이드 보관소
                </h3>
                <p className="text-[10px] font-bold text-slate-400 tracking-wide uppercase mt-0.5">Live Knowledge Directories</p>
              </div>
              
              <button
                onClick={() => {
                  setKbEditingId(null);
                  setKbTitle("");
                  setKbTags("");
                  setKbContent("");
                  setShowKbForm(!showKbForm);
                }}
                className="rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold py-1.5 px-3 flex items-center gap-1 cursor-pointer transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>새 참고 가이드 추가</span>
              </button>
            </div>

            {/* Quick Search & Filter Utility */}
            <div className="space-y-3 mb-6 bg-slate-50/50 border border-slate-100 rounded-xl p-3.5">
              <div className="relative">
                <input
                  id="knowledge-search-input"
                  type="text"
                  placeholder="제목(파일명), 본문 원문 내용, 혹은 카테고리/태그를 실시간 검색하십시오..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full rounded-xl border border-slate-250 bg-white pl-3.5 pr-8 py-2 text-xs focus:border-indigo-500 focus:ring-1 focus:ring-indigo-100 focus:outline-hidden text-slate-800 placeholder:text-slate-400 font-sans"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery("")}
                    className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600 font-bold text-xs"
                  >
                    ✕
                  </button>
                )}
              </div>

              <div className="flex flex-wrap gap-1.5 pt-0.5 animate-fade-in">
                <button
                  type="button"
                  onClick={() => setViewFilter("all")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                    viewFilter === "all"
                      ? "bg-slate-900 text-white shadow-xs"
                      : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  전체 지식 문서 ({allCount})
                </button>
                <button
                  type="button"
                  onClick={() => setViewFilter("uploaded")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                    viewFilter === "uploaded"
                      ? "bg-indigo-600 text-white shadow-xs font-extrabold"
                      : "bg-indigo-555 text-indigo-700 bg-indigo-50 border border-indigo-200/55 hover:bg-indigo-100"
                  }`}
                >
                  <span>📥 추가된 소스 파일만 보기 ({uploadedCount})</span>
                </button>
                <button
                  type="button"
                  onClick={() => setViewFilter("default")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                    viewFilter === "default"
                      ? "bg-slate-900 text-white shadow-xs"
                      : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  ⚙️ 기본 가이드 ({defaultCount})
                </button>
              </div>
            </div>

            {showKbForm && (
              <form onSubmit={handleSaveKb} className="bg-slate-50 border border-slate-200 rounded-xl p-5 mb-5 space-y-4 text-xs animate-fade-in">
                <div className="flex items-center justify-between border-b border-slate-200 pb-2.5">
                  <span className="font-bold text-slate-800 text-xs">
                    {kbEditingId ? `📝 가이드 문서 수정 (ID: ${kbEditingId})` : "➕ 신규 기술 가이드 등록"}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setShowKbForm(false);
                      setKbEditingId(null);
                    }}
                    className="text-slate-400 hover:text-slate-600 font-bold"
                  >
                    창 닫기 ✕
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block font-bold text-slate-600 mb-1">카테고리 (Category)</label>
                    <select
                      value={kbCategory}
                      onChange={(e) => setKbCategory(e.target.value)}
                      className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 focus:border-indigo-500 focus:outline-hidden"
                    >
                      <option value="Cumulus Linux">Cumulus Linux (L2/L3 스위치)</option>
                      <option value="InfiniBand">InfiniBand (HCA 물리 링크/SM)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block font-bold text-slate-600 mb-1">기술 태그 (쉼표로 구분)</label>
                    <input
                      type="text"
                      value={kbTags}
                      placeholder="예: LACP, MLAG, link-speed"
                      onChange={(e) => setKbTags(e.target.value)}
                      className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 focus:border-indigo-500 focus:outline-hidden"
                    />
                  </div>
                </div>

                <div>
                  <label className="block font-bold text-slate-600 mb-1">문서 제목</label>
                  <input
                    type="text"
                    value={kbTitle}
                    placeholder="제목 혹은 고유 장애 유형을 요약해 입력하세요"
                    onChange={(e) => setKbTitle(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 focus:border-indigo-500 focus:outline-hidden text-xs font-semibold"
                    required
                  />
                </div>

                <div>
                  <label className="block font-bold text-slate-600 mb-1">상세 원문 본문</label>
                  <textarea
                    value={kbContent}
                    placeholder="[해당 트러블슈팅 세부 명령이나 텍스트를 기입하세요]"
                    onChange={(e) => setKbContent(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 h-44 focus:border-indigo-500 focus:outline-hidden font-mono text-[11px] leading-relaxed"
                    required
                  />
                </div>

                <div className="flex gap-2">
                  <button
                    type="submit"
                    className="flex-1 rounded-lg bg-indigo-600 py-2 text-white font-semibold hover:bg-indigo-700 transition-colors shadow-2xs cursor-pointer animate-pulse-slow"
                  >
                    저장 완료
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowKbForm(false);
                      setKbEditingId(null);
                    }}
                    className="rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 px-4 py-2 font-semibold transition-colors cursor-pointer"
                  >
                    취소
                  </button>
                </div>
              </form>
            )}

            {loadingDocs && knowledgeBase.length === 0 ? (
              <div className="flex items-center justify-center py-12 text-slate-450">
                <RefreshCw className="h-5 w-5 animate-spin text-indigo-500 mr-2" />
                <span className="text-xs">기술 지식을 실시간 조회 중...</span>
              </div>
            ) : filteredDocs.length === 0 ? (
              <div className="border border-dashed border-slate-200 rounded-xl p-10 text-center text-xs text-slate-400 font-sans">
                {searchQuery || viewFilter !== "all" ? (
                  <>
                    <p className="font-bold text-slate-700 mb-1">🔍 부합하는 지식 가이드가 없습니다.</p>
                    <p className="text-[10px] text-slate-400">검색어 철자를 확인하거나 필터링 분류 탭을 전환해 보세요.</p>
                  </>
                ) : (
                  "등록된 지식 가이드가 없습니다. 소스 가이드 파일을 업로드해 주세요."
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4">
                {filteredDocs.map((doc: any) => (
                  <div
                    key={doc.id}
                    className="border border-slate-150 rounded-xl p-4 hover:border-slate-350 transition-colors bg-slate-50/50 hover:bg-white"
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div>
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <span className={`text-[9px] font-extrabold px-1.5 py-0.5 rounded border ${
                            doc.category === "InfiniBand" 
                              ? "bg-amber-50 text-amber-800 border-amber-200" 
                              : "bg-blue-50 text-blue-800 border-blue-200"
                          }`}>
                            {doc.category || "General"}
                          </span>
                          <span className="text-[9px] text-slate-400 font-mono font-semibold">REF ID: {doc.id}</span>
                        </div>
                        <h4 className="text-xs font-bold text-slate-900 font-sans leading-snug">
                          {doc.title}
                        </h4>
                      </div>

                      <div className="flex gap-1 shrink-0">
                        <button
                          onClick={() => handleEditKb(doc)}
                          className="text-slate-400 hover:text-indigo-600 bg-white border border-slate-200 hover:bg-indigo-50 rounded-md p-1.5 transition-all cursor-pointer text-xs"
                          title="문서 수정"
                        >
                          Modify 📝
                        </button>
                        <button
                          onClick={() => handleDeleteKb(doc.id)}
                          className="text-slate-400 hover:text-red-600 bg-white border border-slate-200 hover:bg-red-50 rounded-md p-1.5 transition-all cursor-pointer"
                          title="문서 삭제"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>

                    <div className="text-[10.5px] text-slate-600 leading-relaxed font-mono whitespace-pre-wrap bg-white p-3 border border-slate-100 rounded-lg overflow-y-auto max-h-36 scrollbar-thin">
                      {doc.content}
                    </div>

                    {doc.tags && doc.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-3">
                        {(doc.tags || []).map((t: string, i: number) => (
                          <span key={i} className="text-[9px] bg-slate-100 text-slate-500 py-0.5 px-1.5 rounded border border-slate-200">
                            #{t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
