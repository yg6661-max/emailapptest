import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc, setLogLevel, collection, getDocs, deleteDoc } from "firebase/firestore";
import * as cheerio from "cheerio";

dotenv.config();

// Turn off internal Firestore SDK logs completely to prevent stream recycling logs
try {
  setLogLevel("silent");
} catch (e) {
  // Gracefully handle if setLogLevel fails or is not supported
}

// Suppress harmless internal Firestore GrpcConnection cancel warnings/errors from polluting container logs
const originalConsoleError = console.error;
console.error = function (...args: any[]) {
  const msg = args.map(arg => String(arg)).join(" ");
  if (
    msg.includes("Disconnecting idle stream") ||
    msg.includes("GrpcConnection RPC 'Listen' stream") ||
    msg.includes("CANCELLED: Disconnecting idle stream") ||
    msg.includes("Timed out waiting for new targets") ||
    msg.includes("stream 0x")
  ) {
    // Gracefully ignore benign background connection pooling recycle events from Firestore SDK
    return;
  }
  originalConsoleError.apply(console, args);
};

const originalConsoleWarn = console.warn;
console.warn = function (...args: any[]) {
  const msg = args.map(arg => String(arg)).join(" ");
  if (
    msg.includes("Disconnecting idle stream") ||
    msg.includes("GrpcConnection RPC 'Listen' stream") ||
    msg.includes("CANCELLED: Disconnecting idle stream") ||
    msg.includes("Timed out waiting for new targets") ||
    msg.includes("stream 0x")
  ) {
    // Gracefully ignore benign background connection pooling recycle warnings from Firestore SDK
    return;
  }
  originalConsoleWarn.apply(console, args);
};

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// In-Memory Database Cache (Pre-loaded from Cloud Firestore at server boot)
let cachedDb: any = null;
let firestoreDb: any = null;
let lastFirestoreError: string | null = null;

// Path to backup file-based local DB for local offline backup or development
const DB_PATH = path.join(process.cwd(), "data", "db.json");

// Pre-seeded high-quality knowledge documents for Cumulus Linux and InfiniBand
const SEED_KNOWLEDGE_DOCS = [
  {
    id: "kb_cumulus_1",
    title: "Cumulus Linux - 링크 애그리게이션 (LACP Bonding / LAG) 설정 가이드",
    category: "Cumulus Linux",
    tags: ["bond", "lacp", "bonding", "lag", "LAG", "cl-net", "network"],
    content: "Cumulus Linux에서 링크 애그리게이션 그룹(LAG, Link Aggregation Group) 또는 LACP 본딩(Bonding)을 설정하여 인터페이스를 결합하고 대역폭을 넓히며 백업 경로를 확보하는 가이드입니다.\n\n1. LACP 본딩 및 LAG 기본 명령어 생성:\n   - cl-net 명령어셋을 사용하여 2개의 인터페이스(swp1, swp2)를 논리 링크 bond1으로 묶습니다.\n   - 명령어 예시:\n     net add bond bond1 bond member swp1,swp2\n     net add bond bond1 bond lacp-rate fast\n     net pending\n     net commit\n\n2. 본딩 인터페이스 세부 확인 방법:\n   - 인터페이스 상태 점검: 'net show interface bond1' 또는 'ip link show bond1'\n   - 본드 요약 정보 확인: 'cat /proc/net/bonding/bond1'\n   - LACP 협상 상태 및 LAG 멤버 확인: 'mst-bond' 도구가 없는 경우, 'net show interface bond1'의 상세 아웃풋 내 lacp_status 세그먼트를 조회합니다.\n\n3. 문제 발생 시 점검 항목:\n   - 파트너 스위치의 LACP 설정이 Active 모드인지 체크하십시오. IP MTU 크기가 1500 또는 Jumbo Frame(9000)으로 맞춰졌는지 확인하세요.",
    updatedAt: "2026-07-12T16:00:00Z"
  },
  {
    id: "kb_cumulus_2",
    title: "Cumulus Linux - VLAN 및 브릿지 인터페이스 기본 트러블슈팅",
    category: "Cumulus Linux",
    tags: ["vlan", "bridge", "interface", "cl-net", "ip"],
    content: "Cumulus Linux에서 가상 랜(VLAN) 및 VXLAN 인터페이스 바인딩 시 연결 장해 트러블슈팅 절차입니다.\n\n1. 대세 브릿지(Bridge) 모드 확인:\n   - Cumulus는 기본적으로 VLAN-aware 브릿지 모델을 채용합니다. 'bridge'라는 하나의 논리 브릿지에 여러 vlan을 허용하는 방식입니다.\n   - 브릿지 확인 명령어: 'brctl show' 또는 'net show bridge'\n\n2. VXLAN 브릿지 매핑 문제 해결:\n   - VXLAN 인터페이스와 VLAN 인터페이스의 매핑을 확인하려면 'net show vxlan'을 실행하세요.\n   - 물리 인터페이스 간 ping 실패 시:\n     가장 먼저 로컬 FDB 테이블에 상대 스위치 MAC이 학습되었는지 점검해야 합니다.\n     명령어: 'bridge fdb show | grep vlan'\n   - cl-net 명령어로 임시 설정 추가 시에는 반드시 'net commit'을 거쳤는지 점검하십시오. 영구 설정은 '/etc/network/interfaces'에 명시됩니다.",
    updatedAt: "2026-07-12T16:00:00Z"
  },
  {
    id: "kb_cumulus_3",
    title: "Cumulus Linux - VXLAN EVPN 멀티호밍 (Multi-Homing) 설정 및 검증 가이드",
    category: "Cumulus Linux",
    tags: ["vxlan", "evpn", "multihoming", "multi-homing", "cl-net", "lag", "LAG"],
    content: "Cumulus Linux에서 이중화 구성을 위해 호스트와 두 대의 리프 스위치 간 active-active 멀티호밍(EVPN MH / LAG)을 설정하고 검증하는 실무 가이드입니다.\n\n1. EVPN 멀티호밍 기본 개념:\n   - 복수의 스위치(VTEP)가 동일한 ESI(Ethernet Segment Identifier)를 공유하여 호스트에게 단일 논리 링크(LAG)로 연결됩니다.\n   - LACP를 기반으로 동작하며, MLAG(Multi-Chassis Link Aggregation)의 현대적인 상위 대체 기술입니다.\n\n2. EVPN MH 본딩 및 인터페이스 설정 (Command 예시):\n   - 호스트 측 본딩 인터페이스 정의:\n     net add bond bond-host1 bond member swp1\n     net add bond bond-host1 evpn-multihoming\n     net add bond bond-host1 clag id 1\n   - 이더넷 세그먼트(ESI) 및 시스템 MAC 수동 설정 (동기화 보장):\n     net add bond bond-host1 evpn-esi 00:11:22:33:44:55:66:77:88:99\n     net add bond bond-host1 evpn-system-mac 00:00:00:11:11:11\n     net pending\n     net commit\n\n3. EVPN 통신 가동 및 검증 명령어:\n   - 전체 이더넷 세그먼트(ES) 상태 점검:\n     'net show evpn es' 또는 'ip link show'\n   - 특정 ESI의 동기화 및 상세 상태 확인:\n     'net show evpn es 상세' 혹은 'bridge es show'\n   - 상대 리프 VTEP 간 LACP 및 MAC 동기화 테이블 점검:\n     'net show evpn mac'\n     'net show evpn next-hops'",
    updatedAt: "2026-07-12T16:00:00Z"
  },
  {
    id: "kb_infiniband_1",
    title: "InfiniBand - 기본 연결 진단 및 명령어 가이드 (ibstat, ibnetdiscover)",
    category: "InfiniBand",
    tags: ["ibstat", "ibnetdiscover", "openSM", "link_up", "mellanox"],
    content: "고성능 컴퓨팅 및 GPU 서버의 백본으로 사용되는 InfiniBand(인피니밴드)의 링크 상태 및 장치 점검 명령어집입니다.\n\n1. ibstat 명령어 (HCA 상태 조회):\n   - 해당 호스트에 장착된 Mellanox HCA 카드의 물리적 포트 수, 상태(State), 물리속도(Physical state)를 점검합니다.\n   - 실행: 'ibstat' 또는 'ibv_devinfo'\n   - 정상 상태일 때 포트 상태가 'Active', 물리적 링크가 'LinkUp'으로 표기되어야 합니다. 그렇지 않고 'Initializing' 상태에 정체되어 있다면 서브넷 매니저(Subnet Manager)가 동작하지 않는 것입니다.\n\n2. 서브넷 매니저(OpenSM) 기동 여부:\n   - 인피니밴드 네트워크에는 활성화된 1개 이상의 서브넷 매니저가 상시 통신을 중재해야 포트가 Active 상태로 들어갑니다.\n   - 스위치에 OpenSM이 동작 중이지 않다면, 특정 컴퓨팅 노드에서 호스트 기반 소프트웨어 OpenSM을 기동할 수 있습니다:\n     'systemctl start opensm' 또는 'opensm -B'\n\n3. ibnetdiscover 명령어 (토폴로지 룩업):\n   - 패브릭에 연결된 모든 스위치와 노드의 GUID 및 호스트네임 배치를 도표화하여 출력합니다.\n   - 사용: 'ibnetdiscover'",
    updatedAt: "2026-07-12T16:00:00Z"
  },
  {
    id: "kb_infiniband_2",
    title: "InfiniBand - NDR/HDR 전송 속도 점검 및 mstflint 펌웨어 도구 오류 해결",
    category: "InfiniBand",
    tags: ["ndr", "hdr", "mstflint", "firmware", "mft", "mellanox"],
    content: "인피니밴드 최신 세대(HDR 200Gb/s, NDR 400Gb/s) 전송 규격 수립 실패 원인 및 Mellanox Firmware Tools(mstflint) 활용법 가이드입니다.\n\n1. 속도 등급 다운그레이드 원인:\n   - 케이블 품질 불량 또는 광트랜시버 이상 체결이나 포트 불량 시 NDR 스위치가 최하위 속도(HDR 또는 EDR)로 링크 타협(Auto-negotiation fallback)을 맺습니다.\n   - 'ibstat' 명령어 출력값 중 'Rate' 항목이 정상 400(NDR) 또는 200(HDR)으로 매칭되었는지 확인하십시오.\n   - 상세 트래픽 및 링크 에러 카운터 조회: 'perfquery' || 'ibqueryerrors'\n\n2. mstflint 장치 로드 오류 해결:\n   - mstflint 도구가 HCA 어댑터를 찾지 못하는 일치 오류 시, 커널 드라이버 'mst' 모듈이 로드되지 않았을 가능성이 높습니다.\n   - 명령어 해결책:\n     'mst start' 명령어 기동 후 드라이버 장치를 활성화한 다음 'mst status'로 PCI 및 어댑터 식별번호를 추출합니다.\n     그 뒤 'mstflint -d <PCI_ADDR> q' 명령어로 펌웨어 버전을 점검하고 최신 버전으로 업데이트를 유도합니다.",
    updatedAt: "2026-07-12T16:00:00Z"
  }
];

// Ensure local directory and default schema exist as a fallback
function initLocalDbBackup() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(DB_PATH)) {
    const defaultData = {
      credentials: {
        clientId: process.env.GOOGLE_CLIENT_ID || "",
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
        accessToken: "",
        refreshToken: "",
        tokenExpiry: 0,
        userEmail: ""
      },
      settings: {
        targetCalendarId: "primary"
      },
      history: [],
      sourceUrls: [],
      knowledgeBase: SEED_KNOWLEDGE_DOCS
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultData, null, 2), "utf8");
    return defaultData;
  }
  try {
    const data = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    if (!data.knowledgeBase || data.knowledgeBase.length === 0) {
      data.knowledgeBase = SEED_KNOWLEDGE_DOCS;
      fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf8");
    }
    if (!data.sourceUrls) {
      data.sourceUrls = [];
    }
    return data;
  } catch (err) {
    console.error("Failed to parse local db backup:", err);
    return { credentials: {}, settings: { targetCalendarId: "primary" }, history: [], sourceUrls: [], knowledgeBase: SEED_KNOWLEDGE_DOCS };
  }
}

// Helper function to sync warm cache with Firestore cloud state
async function syncFromFirestore(): Promise<boolean> {
  if (!firestoreDb) return false;
  try {
    const docRef = doc(firestoreDb, "app_state", "main");
    const docSnap = await getDoc(docRef);

    if (docSnap.exists()) {
      const cloudData = docSnap.data();
      console.log("[Firebase] Successfully fetched remote database state from Firestore.");
      
      // Fetch subcollection knowledge_base if exists
      const kbCollectionRef = collection(firestoreDb, "app_state", "main", "knowledge_base");
      let cloudKbDocs: any[] = [];
      try {
        const kbQuerySnap = await getDocs(kbCollectionRef);
        kbQuerySnap.forEach((d) => {
          if (d.exists()) cloudKbDocs.push(d.data());
        });
      } catch (kbErr) {
        console.warn("[Firebase] Error fetching knowledge_base subcollection items:", kbErr);
      }

      // Fetch subcollection history if exists
      const historyCollectionRef = collection(firestoreDb, "app_state", "main", "history");
      let cloudHistoryDocs: any[] = [];
      try {
        const historyQuerySnap = await getDocs(historyCollectionRef);
        historyQuerySnap.forEach((d) => {
          if (d.exists()) cloudHistoryDocs.push(d.data());
        });
      } catch (histErr) {
        console.warn("[Firebase] Error fetching history subcollection items:", histErr);
      }

      const kbMap = new Map<string, any>();
      SEED_KNOWLEDGE_DOCS.forEach(d => kbMap.set(d.id, d));
      
      const cloudKb = cloudKbDocs.length > 0 ? cloudKbDocs : (cloudData.knowledgeBase || []);
      if (Array.isArray(cloudKb)) {
        cloudKb.forEach((d: any) => {
          if (d && d.id) {
            const existing = kbMap.get(d.id);
            if (!existing) {
              kbMap.set(d.id, d);
            } else {
              const cloudTime = d.updatedAt ? new Date(d.updatedAt).getTime() : 0;
              const existingTime = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
              if (cloudTime >= existingTime) {
                kbMap.set(d.id, d);
              }
            }
          }
        });
      }

      if (cachedDb && Array.isArray(cachedDb.knowledgeBase)) {
        cachedDb.knowledgeBase.forEach((d: any) => {
          if (d && d.id) {
            const existing = kbMap.get(d.id);
            if (!existing) {
              kbMap.set(d.id, d);
            } else {
              const localTime = d.updatedAt ? new Date(d.updatedAt).getTime() : 0;
              const existingTime = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
              if (localTime >= existingTime) {
                kbMap.set(d.id, d);
              }
            }
          }
        });
      }

      const mergedKnowledgeBase = Array.from(kbMap.values());

      const historyMap = new Map<string, any>();
      let cloudHistory = cloudHistoryDocs.length > 0 ? cloudHistoryDocs : (cloudData.history || []);
      if (Array.isArray(cloudHistory)) {
        cloudHistory = cloudHistory
          .sort((a: any, b: any) => {
            const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
            const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
            return timeB - timeA;
          })
          .slice(0, 150);

        cloudHistory.forEach((d: any) => {
          if (d && d.id) {
            historyMap.set(d.id, d);
          }
        });
      }

      if (cachedDb && Array.isArray(cachedDb.history)) {
        cachedDb.history.forEach((d: any) => {
          if (d && d.id) {
            const existing = historyMap.get(d.id);
            if (!existing) {
              historyMap.set(d.id, d);
            } else {
              const cloudTime = existing.timestamp ? new Date(existing.timestamp).getTime() : 0;
              const localTime = d.timestamp ? new Date(d.timestamp).getTime() : 0;
              if (localTime >= cloudTime) {
                historyMap.set(d.id, d);
              }
            }
          }
        });
      }

      const mergedHistory = Array.from(historyMap.values())
        .sort((a: any, b: any) => {
          const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          return timeB - timeA;
        })
        .slice(0, 150);

      cachedDb = {
        credentials: {
          ...((cachedDb && cachedDb.credentials) || {}),
          ...(cloudData.credentials || {})
        },
        settings: cloudData.settings || (cachedDb && cachedDb.settings) || { targetCalendarId: "primary" },
        history: mergedHistory,
        sourceUrls: cloudData.sourceUrls || (cachedDb && cachedDb.sourceUrls) || [],
        knowledgeBase: mergedKnowledgeBase
      };
      
      try {
        fs.writeFileSync(DB_PATH, JSON.stringify(cachedDb, null, 2), "utf8");
      } catch (e) {
        console.error("[Local Backup] Failed to write database state:", e);
      }
    } else {
      console.log("[Firebase] No existing cloud database found in Firestore. Seeding initial baseline...");
      const { knowledgeBase, history, ...mainDataWithoutKbAndHistory } = cachedDb;
      await setDoc(docRef, mainDataWithoutKbAndHistory);
      if (Array.isArray(cachedDb.knowledgeBase)) {
        for (const kbDoc of cachedDb.knowledgeBase) {
          if (kbDoc && kbDoc.id) {
            const kbDocRef = doc(firestoreDb, "app_state", "main", "knowledge_base", kbDoc.id);
            await setDoc(kbDocRef, kbDoc);
          }
        }
      }
      if (Array.isArray(cachedDb.history)) {
        for (const histDoc of cachedDb.history) {
          if (histDoc && histDoc.id) {
            const histDocRef = doc(firestoreDb, "app_state", "main", "history", histDoc.id);
            await setDoc(histDocRef, histDoc);
          }
        }
      }
    }

    lastFirestoreError = null; // Succeeded!
    return true;
  } catch (error: any) {
    const errMsg = error?.message || String(error);
    console.warn("[Firebase] Operating in local database mode:", errMsg);
    // When local cachedDb is active and populated, treat local mode as healthy operational baseline
    if (cachedDb && Array.isArray(cachedDb.knowledgeBase) && cachedDb.knowledgeBase.length > 0) {
      lastFirestoreError = null;
    } else {
      lastFirestoreError = errMsg;
    }
    return false;
  }
}

// Bootstrapper to initialize Firebase and populate cachedDb from Firestore
async function initDbAndSyncFirestore() {
  // 1. Instantly parse local backup to prevent boot blocks
  const localData = initLocalDbBackup();
  cachedDb = localData;

  // 2. Initialize Firestore utilizing existing client profiles
  try {
    const configPath = path.join(process.cwd(), "firebase-applet-config.json");
    if (fs.existsSync(configPath)) {
      const firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const firebaseApp = initializeApp(firebaseConfig);
      let databaseId = firebaseConfig.firestoreDatabaseId;
      if (!databaseId) {
        try {
          const fbJsonPath = path.join(process.cwd(), "firebase.json");
          if (fs.existsSync(fbJsonPath)) {
            const fbJson = JSON.parse(fs.readFileSync(fbJsonPath, "utf8"));
            if (Array.isArray(fbJson.firestore) && fbJson.firestore[0]?.database) {
              databaseId = fbJson.firestore[0].database;
            } else if (typeof fbJson.firestore?.database === "string") {
              databaseId = fbJson.firestore.database;
            }
          }
        } catch {
          // ignore
        }
      }
      if (!databaseId && firebaseConfig.projectId === "utopian-octane-r6m9v") {
        databaseId = "ai-studio-emailcalendarsch-a7c22c58-dd8b-4d29-ba80-720d5cc62455";
      }

      firestoreDb = databaseId
        ? getFirestore(firebaseApp, databaseId)
        : getFirestore(firebaseApp);
      
      console.log(`[Firebase] Server-side Firestore client initialized successfully! (Database: ${databaseId || "(default)"})`);

      // 3. Sync from warm persistent cloud
      const synced = await syncFromFirestore();
      if (!synced) {
        // Retrying once after 1 second if transient socket connection failed on immediate boot
        setTimeout(() => {
          syncFromFirestore().then((res) => {
            if (res) console.log("[Firebase] Delayed boot sync succeeded!");
          });
        }, 1500);
      }
    } else {
      console.warn("[Firebase] firebase-applet-config.json not found. Operating strictly on ephemeral local files.");
    }
  } catch (error: any) {
    console.warn("[Firebase] Operating in local database mode:", error?.message || error);
    if (!cachedDb) {
      lastFirestoreError = error?.message || String(error);
    }
  }
}

// Read database (Return pre-loaded memory cache synchronously for high performance)
function readDb() {
  if (!cachedDb) {
    console.warn("[DB Cache] Read called before initialization. Serving fresh local template.");
    return initLocalDbBackup();
  }
  return cachedDb;
}

// Write database (Asynchronous persistence to guarantee storage integrity under serverless scale/sleep conditions)
async function writeDb(data: any) {
  if (!data) return;

  // Guard: Avoid exceeding Firestore's 1MB document size limit (keep max 150 processing log elements)
  if (data.history && data.history.length > 150) {
    data.history = data.history.slice(0, 150);
  }

  // Update warm memory cache immediately to guarantee instant single-session consistency
  cachedDb = data;

  // Synchronously serialize to disk backup (Double write protection)
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch (error) {
    console.error("[Local Backup] Failed to write local DB backup:", error);
  }

  // Synchronize changes to Cloud Firestore and await to ensure complete write before container gets frozen/idle
  if (firestoreDb) {
    const docRef = doc(firestoreDb, "app_state", "main");
    try {
      // Save settings, credentials, and logs to the main document, omitting the large knowledgeBase and history arrays
      const { knowledgeBase, history, ...mainDataWithoutKbAndHistory } = data;
      await setDoc(docRef, mainDataWithoutKbAndHistory);
      console.log("[Firebase] Successfully persisted main state to Firestore.");

      // Individually save each knowledge document to the subcollection to prevent the 1MB limit crash
      if (Array.isArray(knowledgeBase)) {
        for (const kbDoc of knowledgeBase) {
          if (kbDoc && kbDoc.id) {
            const kbDocRef = doc(firestoreDb, "app_state", "main", "knowledge_base", kbDoc.id);
            await setDoc(kbDocRef, kbDoc);
          }
        }
      }

      // Individually save each history document to the subcollection to prevent the 1MB limit crash
      if (Array.isArray(history)) {
        for (const histDoc of history) {
          if (histDoc && histDoc.id) {
            const histDocRef = doc(firestoreDb, "app_state", "main", "history", histDoc.id);
            await setDoc(histDocRef, histDoc);
          }
        }
      }
      lastFirestoreError = null; // Clear on success
    } catch (err: any) {
      console.warn("[Firebase] Operating in local database write mode:", err?.message || err);
      if (!cachedDb) {
        lastFirestoreError = err?.message || String(err);
      }
    }
  }
}

// Initialize Gemini SDK lazily
let aiClient: GoogleGenAI | null = null;
let lastApiKey: string | null = null;

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is missing.");
  }
  
  if (!aiClient || lastApiKey !== apiKey) {
    lastApiKey = apiKey;
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        }
      }
    });
  }
  return aiClient;
}

// Check and refresh Google access token if needed
async function getValidAccessToken(): Promise<string | null> {
  const db = readDb();
  const creds = db.credentials;

  if (!creds || !creds.accessToken) {
    return null;
  }

  const clientId = creds.clientId || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = creds.clientSecret || process.env.GOOGLE_CLIENT_SECRET;

  const now = Date.now();
  // If token is near expiration (under 15 min left), proactively try to refresh it
  if (creds.tokenExpiry && now >= creds.tokenExpiry - 900 * 1000) {
    if (creds.refreshToken && clientId && clientSecret) {
      console.log("Refreshing expired or nearly expired Google access token (Proactive Safe Refresh)...");
      try {
        const response = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: creds.refreshToken,
            grant_type: "refresh_token",
          }),
        });

        const tokens = await response.json();
        if (response.ok && tokens.access_token) {
          creds.accessToken = tokens.access_token;
          if (tokens.expires_in) {
            creds.tokenExpiry = Date.now() + tokens.expires_in * 1000;
          }
          if (tokens.refresh_token) {
            creds.refreshToken = tokens.refresh_token;
          }
          db.credentials = creds;
          writeDb(db);
          console.log("Token refreshed successfully.");
          return tokens.access_token;
        } else {
          console.log("[OAuth] Clean connection up: Google OAuth refresh token was expired or revoked, session has been cleared.");
          // If refresh token is invalid or revoked, force disconnect fully
          creds.accessToken = "";
          creds.refreshToken = "";
          creds.tokenExpiry = 0;
          db.credentials = creds;
          writeDb(db);
          return null;
        }
      } catch (error) {
        console.warn("Network warning during Google token refresh:", error);
        return creds.accessToken; // Fallback to current token if network error occurs
      }
    } else {
      // If no credentials or no refresh token is present, we check if it is fully expired
      if (now >= creds.tokenExpiry) {
        console.warn("Google token has fully expired and no refresh token is available. Clean connection up.");
        creds.accessToken = "";
        creds.tokenExpiry = 0;
        db.credentials = creds;
        writeDb(db);
        return null;
      }
    }
  }

  return creds.accessToken;
}

// Background task daemon macro to automatically check and refresh expired tokens every 5 minutes
function startBackgroundTokenRefresher() {
  console.log("Starting server-side background token refresher daemon macro...");
  // Check and keep tokens fresh every 5 minutes
  setInterval(async () => {
    try {
      const db = readDb();
      const creds = db.credentials;
      if (creds && creds.accessToken) {
        if (creds.refreshToken) {
          console.log("[Background Macro] Proactively checking/refreshing Google Calendar token validity...");
          const token = await getValidAccessToken();
          if (token) {
            const minLeft = Math.ceil((creds.tokenExpiry - Date.now()) / 60000);
            console.log(`[Background Macro] Token is alive. Remaining: ~${minLeft} minutes.`);
          } else {
            console.warn("[Background Macro] Background token refresh returned null or failed.");
          }
        } else {
          // If manual token (bypass, no refresh token) is about to or has expired
          const now = Date.now();
          if (creds.tokenExpiry && now >= creds.tokenExpiry) {
            console.log("[Background Macro] Manual access token has expired. Cleaning up...");
            creds.accessToken = "";
            creds.tokenExpiry = 0;
            db.credentials = creds;
            writeDb(db);
          }
        }
      }
    } catch (err) {
      console.error("[Background Macro] Error in background token refresher:", err);
    }
  }, 5 * 60 * 1000); // 5 minutes
}

// Background automatic RAG crawler sync daemon (runs check every 1 hour, triggers recrawl if doc count is 0 or older than 3 days)
function startBackgroundAutoRecrawlScheduler() {
  console.log("[Auto-Recrawl Scheduler] Starting RAG source auto-sync daemon...");
  
  // Running check every hour (1 * 60 * 60 * 1000)
  setInterval(async () => {
    try {
      await checkAndRunAutoRecrawl();
    } catch (err) {
      console.error("[Auto-Recrawl Scheduler] Error in daemon check cycle:", err);
    }
  }, 1 * 60 * 60 * 1000); // Check every 1 hour

  // Also do a small initial trigger check after 15 seconds of boot
  setTimeout(async () => {
    try {
      console.log("[Auto-Recrawl Scheduler] Running initial boot RAG source check...");
      await checkAndRunAutoRecrawl();
    } catch (err) {
      console.error("[Auto-Recrawl Scheduler] Error in initial boot check:", err);
    }
  }, 15000); // 15 seconds after start to let firestore init settle down
}

// Check all registered source URLs and crawl if missing or older than 3 days
async function checkAndRunAutoRecrawl() {
  const db = readDb();
  if (!db.sourceUrls || db.sourceUrls.length === 0) {
    console.log("[Auto-Recrawl] No registered crawling sources found. Idle.");
    return;
  }

  console.log(`[Auto-Recrawl] Inspecting ${db.sourceUrls.length} registered RAG source URLs...`);

  for (const source of db.sourceUrls) {
    if (!source.url) continue;

    // Check actual document count in knowledgeBase belonging to this source
    const actualCount = (db.knowledgeBase || []).filter((doc: any) => {
      if (!doc.id || !doc.id.startsWith("kb_crawl_")) return false;
      if (doc.sourceUrl) {
        return doc.sourceUrl.toLowerCase().replace(/\/+$/, "") === source.url.toLowerCase().replace(/\/+$/, "");
      }
      if (doc.content) {
        const match = doc.content.match(/\[출처 URL: ([^\]]+)\]/);
        if (match && match[1]) {
          const cleanDocUrl = match[1].toLowerCase().trim().replace(/\/+$/, "");
          const cleanStartUrl = source.url.toLowerCase().trim().replace(/\/+$/, "");
          return cleanDocUrl.startsWith(cleanStartUrl) || cleanDocUrl === cleanStartUrl;
        }
      }
      return false;
    }).length;

    const now = Date.now();
    const lastCrawledTime = source.lastCrawledAt ? new Date(source.lastCrawledAt).getTime() : 0;
    const isStale = (now - lastCrawledTime) > 3 * 24 * 60 * 60 * 1000; // 3 days
    const isMissing = actualCount === 0;

    if (isMissing || isStale) {
      const reason = isMissing 
        ? `수집된 지식 문서 없음 (데이터 복구 유도 - 실제 색인수: ${actualCount}개)` 
        : `마지막 수집 후 3일 경과 (마지막 수집: ${source.lastCrawledAt})`;
        
      console.log(`[Auto-Recrawl] Triggering auto-recrawl for: ${source.url} (${reason})`);
      
      try {
        // Delete older crawled files belonging to this specific source first to prevent accumulation/duplicates
        if (actualCount > 0) {
          const dbCurrent = readDb();
          const itemsToDelete = (dbCurrent.knowledgeBase || []).filter((doc: any) => {
            if (!doc.id || !doc.id.startsWith("kb_crawl_")) return false;
            if (doc.sourceUrl) {
              return doc.sourceUrl.toLowerCase().replace(/\/+$/, "") === source.url.toLowerCase().replace(/\/+$/, "");
            }
            if (doc.content) {
              const match = doc.content.match(/\[출처 URL: ([^\]]+)\]/);
              if (match && match[1]) {
                const cleanDocUrl = match[1].toLowerCase().trim().replace(/\/+$/, "");
                const cleanStartUrl = source.url.toLowerCase().trim().replace(/\/+$/, "");
                return cleanDocUrl.startsWith(cleanStartUrl) || cleanDocUrl === cleanStartUrl;
              }
            }
            return false;
          });

          if (itemsToDelete.length > 0) {
            console.log(`[Auto-Recrawl] Cleaned ${itemsToDelete.length} stale/displaced documents before recrawling.`);
            dbCurrent.knowledgeBase = dbCurrent.knowledgeBase.filter(
              (doc: any) => !itemsToDelete.some((delItem: any) => delItem.id === doc.id)
            );
            
            // Sync deletion to Firestore
            if (firestoreDb) {
              for (const delDoc of itemsToDelete) {
                try {
                  const docRef = doc(firestoreDb, "app_state", "main", "knowledge_base", delDoc.id);
                  await deleteDoc(docRef);
                } catch (fbErr) {
                  // ignore
                }
              }
            }
            await writeDb(dbCurrent);
          }
        }

        // Silent programmatical crawl
        console.log(`[Auto-Recrawl] Silent crawler launched on: ${source.url}`);
        
        let resolvedUrl = source.url.trim();
        if (!/^https?:\/\//i.test(resolvedUrl)) {
          resolvedUrl = "https://" + resolvedUrl;
        }

        const startUrlObj = new URL(resolvedUrl);
        const allowedHostname = startUrlObj.hostname;

        const pagesToCrawl = Math.min(Math.max(source.maxPages || 10, 1), 50);
        const depthToCrawl = Math.min(Math.max(source.maxDepth || 2, 1), 4);
        const docCategory = source.category || "Crawled Web";

        const queue: { url: string; depth: number }[] = [{ url: startUrlObj.href, depth: 1 }];
        const crawledUrls = new Set<string>();
        let successCount = 0;

        const fetchWithTimeout = async (targetUrl: string, timeoutMs = 6000) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const response = await fetch(targetUrl, {
              signal: controller.signal,
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
                "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
                "Cache-Control": "no-cache"
              }
            });
            clearTimeout(timer);
            return response;
          } catch (err) {
            clearTimeout(timer);
            throw err;
          }
        };

        while (queue.length > 0 && crawledUrls.size < pagesToCrawl) {
          const current = queue.shift();
          if (!current) continue;

          if (crawledUrls.has(current.url)) {
            continue;
          }

          crawledUrls.add(current.url);

          try {
            // Politeness delay
            await new Promise((resolve) => setTimeout(resolve, 300));

            const response = await fetchWithTimeout(current.url);
            if (!response.ok) continue;

            const contentType = response.headers.get("content-type") || "";
            if (!contentType.toLowerCase().includes("text/html")) continue;

            const html = await response.text();
            const { title: cleanTitle, content: bodyText, childHrefs } = cleanHtmlContent(html, current.url);

            // Extract child URLs first before depth limit
            if (current.depth < depthToCrawl) {
              childHrefs.forEach((href) => {
                try {
                  const resolved = new URL(href, current.url);
                  if (resolved.hostname === allowedHostname && (resolved.protocol === "http:" || resolved.protocol === "https:")) {
                    resolved.hash = "";
                    const cleanHref = resolved.href;

                    let isSameSubfolder = false;
                    try {
                      const startPathClean = startUrlObj.pathname.toLowerCase().replace(/\/+$/, "");
                      const resolvedPathClean = resolved.pathname.toLowerCase().replace(/\/+$/, "");
                      
                      if (!startPathClean || startPathClean === "/" || startPathClean === "") {
                        isSameSubfolder = true;
                      } else {
                        isSameSubfolder = resolvedPathClean.startsWith(startPathClean);
                      }
                    } catch (e) {
                      isSameSubfolder = true;
                    }

                    if (!isSameSubfolder) return;

                    if (!crawledUrls.has(cleanHref) && !queue.some((q) => q.url === cleanHref)) {
                      const pathname = resolved.pathname.toLowerCase();
                      const staticAssets = [".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip", ".tar", ".gz", ".exe", ".dmg", ".mp4", ".css", ".js", ".json", ".xml", ".svg", ".avi"];
                      if (!staticAssets.some((ext) => pathname.endsWith(ext))) {
                        queue.push({ url: cleanHref, depth: current.depth + 1 });
                      }
                    }
                  }
                } catch (err) {
                  // ignore
                }
              });
            }

            if (bodyText.length < 40) continue;

            const sourceMetadata = `[출처 URL: ${current.url}]\n[크롤링 수준: Depth ${current.depth}]\n\n`;
            const finalContent = sourceMetadata + bodyText;

            const dbCurrent = readDb();
            if (!dbCurrent.knowledgeBase) dbCurrent.knowledgeBase = [];

            const combinedForTags = `${cleanTitle} ${bodyText}`.toLowerCase();
            const autoTags = ["crawled", allowedHostname];
            
            const possibleTechKeywords = [
              { key: "ufm", matches: ["ufm", "unified fabric manager", "ufm-sdn", "nvidia-sm"] },
              { key: "lacp", matches: ["lacp", "bonding", "cl-net", "bond"] },
              { key: "bonding", matches: ["bonding", "bond", "lacp"] },
              { key: "bridge", matches: ["bridge", "vlan bridge", "브릿지", "브리짓"] },
              { key: "vlan", matches: ["vlan", "vlans"] },
              { key: "vxlan", matches: ["vxlan", "vxlans"] },
              { key: "cumulus", matches: ["cumulus", "큐물러스"] },
              { key: "infiniband", matches: ["infiniband", "인피니밴드", "mellanox", "hca"] },
              { key: "opensm", matches: ["opensm", "openSM"] },
              { key: "mstflint", matches: ["mstflint", "펌웨어", "firmware"] },
              { key: "guid", matches: ["guid", "hca", "어댑터"] },
              { key: "ibstat", matches: ["ibstat", "ibnetdiscover"] },
              { key: "nvidia", matches: ["nvidia", "mellanox"] }
            ];

            possibleTechKeywords.forEach(t => {
              if (t.matches.some(m => combinedForTags.includes(m))) {
                if (!autoTags.includes(t.key)) {
                  autoTags.push(t.key);
                }
              }
            });

            // Check if document already exists to avoid duplication
            const existingIdx = dbCurrent.knowledgeBase.findIndex((doc: any) => {
              if (doc.sourceUrl && doc.sourceUrl.toLowerCase().replace(/\/+$/, "") === current.url.toLowerCase().replace(/\/+$/, "")) return true;
              if (cleanSourceTitle(doc.title) === cleanSourceTitle(cleanTitle)) return true;
              return false;
            });

            if (existingIdx !== -1) {
              dbCurrent.knowledgeBase[existingIdx] = {
                ...dbCurrent.knowledgeBase[existingIdx],
                title: `[웹사이트] ${cleanTitle}`,
                tags: autoTags,
                sourceUrl: current.url,
                content: finalContent,
                updatedAt: new Date().toISOString()
              };
            } else {
              const targetId = `kb_crawl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
              const docItem = {
                id: targetId,
                title: `[웹사이트] ${cleanTitle}`,
                category: docCategory,
                tags: autoTags,
                sourceUrl: current.url,
                content: finalContent,
                updatedAt: new Date().toISOString()
              };
              dbCurrent.knowledgeBase.unshift(docItem);
            }

            await writeDb(dbCurrent);
            successCount++;

          } catch (crawlErr: any) {
            console.error(`[Auto-Recrawl] Error crawling ${current.url}:`, crawlErr.message || crawlErr);
          }
        }

        // Complete source update
        const dbPost = readDb();
        if (!dbPost.sourceUrls) dbPost.sourceUrls = [];
        const matchedSrcIdx = dbPost.sourceUrls.findIndex((item: any) => {
          return item.url.toLowerCase().replace(/\/+$/, "") === startUrlObj.href.toLowerCase().replace(/\/+$/, "");
        });

        if (matchedSrcIdx !== -1) {
          dbPost.sourceUrls[matchedSrcIdx].lastCrawledAt = new Date().toISOString();
          dbPost.sourceUrls[matchedSrcIdx].count = successCount;
          await writeDb(dbPost);
        }

        console.log(`[Auto-Recrawl] Auto-recrawl successfully completed for ${source.url}! Harvested ${successCount} documents.`);

      } catch (crawlGlobalErr: any) {
        console.error(`[Auto-Recrawl] Critical error in automatic crawling process for ${source.url}:`, crawlGlobalErr.message || crawlGlobalErr);
      }
    } else {
      console.log(`[Auto-Recrawl] Source ${source.url} is up-to-date and has valid documents (Count: ${actualCount}개, Last: ${source.lastCrawledAt}).`);
    }
  }
}

   // Helper to detect if email is a reply, forward, or part of a thread
function checkIfReply(subject: string, body: string): boolean {
  const cleanSubject = (subject || "").trim().toLowerCase();
  
  // Check typical Korean or English email reply/forward prefixes
  if (
    cleanSubject.startsWith("re:") || 
    cleanSubject.startsWith("re ") ||
    cleanSubject.includes("re:") || 
    cleanSubject.startsWith("fw:") || 
    cleanSubject.includes("fw:") ||
    cleanSubject.startsWith("re；") ||
    cleanSubject.startsWith("re :") ||
    cleanSubject.startsWith("회신:") ||
    cleanSubject.includes("회신:") ||
    cleanSubject.startsWith("전달:") ||
    cleanSubject.includes("전달:")
  ) {
    return true;
  }
  
  // Also scan if the email body shows classic quoted block headers
  const cleanBody = (body || "");
  if (
    cleanBody.includes("-----Original Message-----") ||
    cleanBody.includes("----- Original Message -----") ||
    /On\s+.*\s+wrote:/i.test(cleanBody) ||
    /님이\s+작성:/i.test(cleanBody)
  ) {
    return true;
  }
  
  return false;
}

// Helper to strip previous thread messages from a reply email so Gemini doesn't get confused by past dates
function cleanReplyBody(body: string): string {
  if (!body) return "";
  
  const lines = body.split(/\r?\n/);
  const cleanLines: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineTrim = line.trim();
    
    // Scan for diverse email platform reply block splits
    if (
      lineTrim.includes("-----Original Message-----") ||
      lineTrim.includes("----- Original Message -----") ||
      (lineTrim.startsWith("From:") && i > 0 && lines[i-1].trim() === "") ||
      /^On\s+.*\s+wrote:$/i.test(lineTrim) ||
      /\d{4}년\s+\d{1,2}월\s+\d{1,2}일\s+.*작성:/.test(lineTrim) ||
      lineTrim.startsWith(">")
    ) {
      break; // Thread boundary found! Discard any quoted text below.
    }
    cleanLines.push(line);
  }
  
  const cleaned = cleanLines.join("\n").trim();
  // Ensure we didn't end up with an empty/too-short body due to aggressive truncation
  if (cleaned.length > 50) {
    return cleaned;
  }
  
  return body;
}

// Helper to simplify and clean matched source titles
function cleanSourceTitle(title: string): string {
  if (!title) return "";
  title = title.replace(/v?\d+\.\d+(?:\.\d+)*(?:\s*LTS)?(?:layout-\d+)*/gi, "").trim();

  let clean = title
    .replace(/^\[웹사이트\]\s*/g, "")
    .replace(/^\[파일\]\s*/g, "")
    .replace(/^\[지식 문서\]\s*/g, "");
  
  if (clean.includes("|")) {
    const parts = clean.split("|");
    if (parts[0].trim().length > 3) {
      clean = parts[0].trim();
    }
  }
  return clean
    .replace(/layout-\d+|search-\d+|wy-[a-z0-9-]+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Helper to simplify matched source titles into clean, concise tags
function formatShortSourceTitle(title: string): string {
  if (!title) return "";
  const raw = title.toLowerCase();

  if (raw.includes("lacp") || (raw.includes("cumulus") && (raw.includes("lag") || raw.includes("bonding") || raw.includes("본딩")))) {
    return "Cumulus LACP/LAG 가이드";
  }
  if (raw.includes("vxlan") || raw.includes("evpn") || raw.includes("multihoming") || raw.includes("멀티호밍")) {
    return "Cumulus EVPN 멀티호밍";
  }
  if (raw.includes("cumulus") && (raw.includes("vlan") || raw.includes("bridge") || raw.includes("브릿지") || raw.includes("브리지"))) {
    return "Cumulus VLAN/브릿지";
  }
  if (raw.includes("cumulus") && (raw.includes("guide") || raw.includes("매뉴얼") || raw.includes("가이드"))) {
    return "Cumulus Linux 매뉴얼";
  }
  if (raw.includes("infiniband") && (raw.includes("ndr") || raw.includes("hdr") || raw.includes("mstflint") || raw.includes("펌웨어") || raw.includes("firmware") || raw.includes("속도"))) {
    return "InfiniBand NDR/속도 점검";
  }
  if (raw.includes("infiniband") && (raw.includes("ibstat") || raw.includes("ibnetdiscover") || raw.includes("진단") || raw.includes("연결") || raw.includes("opensm"))) {
    return "InfiniBand 연결 진단";
  }
  if (raw.includes("mlnx-os") || raw.includes("mlnxos")) {
    return "NVIDIA MLNX-OS 매뉴얼";
  }
  if (raw.includes("ufm") && (raw.includes("user") || raw.includes("management") || raw.includes("계정") || raw.includes("사용자"))) {
    return "NVIDIA UFM 사용자 관리";
  }
  if (raw.includes("ufm")) {
    return "NVIDIA UFM 매뉴얼";
  }

  let clean = title
    .replace(/^\[웹사이트\]\s*/g, "")
    .replace(/^\[파일\]\s*/g, "")
    .replace(/^\[지식 문서\]\s*/g, "");

  if (clean.includes("|")) {
    const parts = clean.split("|");
    if (parts[0].trim().length > 2) {
      clean = parts[0].trim();
    }
  }

  clean = clean.replace(/layout-\d+|search-\d+|wy-[a-z0-9-]+/gi, "").trim();
  clean = clean.replace(/\([^)]*\)/g, "").trim();
  if (clean.includes(" - ")) {
    const parts = clean.split(" - ");
    clean = `${parts[0].trim()} ${parts[1].trim()}`;
  }
  clean = clean
    .replace(/가이드|메뉴얼|매뉴얼|기본\s*트러블슈팅|설정\s*및\s*검증/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (clean.length > 22) {
    clean = clean.substring(0, 22).trim() + "..";
  }
  return clean || title;
}

// Strip crawler and web layout artifacts from document content
function cleanDocumentForRag(content: string): string {
  if (!content) return "";
  let clean = content
    .replace(/^\[출처 URL:[^\]]+\]\s*/gmi, "")
    .replace(/^\[크롤링 수준:[^\]]+\]\s*/gmi, "")
    .replace(/skip to main content/gi, "")
    .replace(/breadcrumbs/gi, "")
    .replace(/download pdf/gi, "")
    .replace(/chevron_right/gi, "")
    .replace(/v\d+\.\d+v\d+\.\d+/gi, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clean;
}

// Clean HTML content removing navigation, sidebars, version switchers, and breadcrumbs
function cleanHtmlContent(rawHtml: string, pageUrl: string): { title: string; content: string; childHrefs: string[] } {
  const $ = cheerio.load(rawHtml);
  
  // 1. Collect child links BEFORE removing nav elements
  const childHrefs: string[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (href) childHrefs.push(href);
  });

  // 2. Remove all non-content and layout/navigation boilerplate
  $(
    "script, style, noscript, iframe, svg, nav, footer, header, head, " +
    ".header, .footer, .nav, .sidebar, #sidebar, .menu, #menu, .banner, .ads, " +
    ".wy-nav-side, .wy-side-scroll, .wy-breadcrumbs, .md-sidebar, .md-nav, .toc, .table-of-contents, " +
    ".navigation, .navbar, [role='navigation'], [role='banner'], [role='contentinfo'], " +
    ".version-switcher, .dropdown, button, form, input, .copyright, .feedback-section, .pagination, .page-nav, " +
    ".skip-link, a[href='#main-content'], .layout-top, .search-container, .breadcrumbs, .breadcrumb, " +
    ".rst-versions, .wy-nav-content-wrap > nav, .md-header, .md-tabs, .search-box"
  ).remove();

  // Extract clean title
  let title = $("title").text().trim();
  if (!title) {
    title = $("h1").first().text().trim() || pageUrl.replace(/^https?:\/\//i, "");
  }
  title = cleanSourceTitle(title);

  // Convert key tags for structured formatting
  $("h1").each((_, el) => { $(el).replaceWith(`\n# ${$(el).text().trim()}\n`); });
  $("h2").each((_, el) => { $(el).replaceWith(`\n## ${$(el).text().trim()}\n`); });
  $("h3, h4, h5, h6").each((_, el) => { $(el).replaceWith(`\n### ${$(el).text().trim()}\n`); });
  $("pre, code").each((_, el) => {
    const codeText = $(el).text().trim();
    if (codeText.includes("\n") || codeText.length > 20) {
      $(el).replaceWith(`\n\`\`\`\n${codeText}\n\`\`\`\n`);
    } else {
      $(el).replaceWith(`\`${codeText}\``);
    }
  });
  $("p").each((_, el) => { $(el).replaceWith(`\n${$(el).text().trim()}\n`); });
  $("li").each((_, el) => { $(el).replaceWith(`\n- ${$(el).text().trim()}`); });
  $("br").replaceWith("\n");

  // Get raw body text or main article text
  let mainText = $("main, article, [role='main'], .document, .content, .rst-content, .markdown-section, body").first().text() || $("body").text();

  // Filter out line-level boilerplate
  const boilerplatePatterns = [
    /skip to main content/i,
    /breadcrumbs/i,
    /download pdf/i,
    /chevron_right/i,
    /v\d+\.\d+v\d+\.\d+/i,
    /document revision history/i,
    /copyright.*nvidia/i,
    /all rights reserved/i,
    /technical support/i,
    /was this page helpful/i,
    /feedback/i,
  ];

  const lines = mainText.split(/\r?\n/);
  const cleanLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (boilerplatePatterns.some(p => p.test(trimmed))) continue;
    cleanLines.push(trimmed);
  }

  let content = cleanLines.join("\n\n").trim();
  content = content.replace(/\n{3,}/g, "\n\n");

  if (content.length > 25000) {
    content = content.substring(0, 25000) + "\n\n...[지식 보관소 한도로 데이터 축약됨]";
  }

  return { title, content, childHrefs };
}

// Synthesize a high-precision, structured Korean technical response based on matched documents
function synthesizeRagAnswer(subject: string, body: string, matchedDocs: any[]): { answer: string; matchedSources: string[] } {
  if (!matchedDocs || matchedDocs.length === 0) {
    return {
      answer: "RAG 검색 결과 관련 내용이 없습니다.",
      matchedSources: []
    };
  }

  const queryCombined = `${subject} ${body}`.toLowerCase();
  const matchedSources = Array.from(new Set(matchedDocs.map(d => formatShortSourceTitle(d.title || "")))).filter(Boolean);

  // Check specific topic domains
  const isLacpLag = queryCombined.includes("lacp") || queryCombined.includes("lag") || queryCombined.includes("bonding") || queryCombined.includes("본딩");
  const isVlanBridge = queryCombined.includes("vlan") || queryCombined.includes("bridge") || queryCombined.includes("브릿지") || queryCombined.includes("브리지");
  const isVxlanEvpn = queryCombined.includes("vxlan") || queryCombined.includes("evpn") || queryCombined.includes("multihoming") || queryCombined.includes("멀티호밍");
  const isIbStat = queryCombined.includes("ibstat") || queryCombined.includes("link") || queryCombined.includes("속도") || queryCombined.includes("guid") || queryCombined.includes("ndr") || queryCombined.includes("hdr");
  const isFirmwareMst = queryCombined.includes("mstflint") || queryCombined.includes("firmware") || queryCombined.includes("펌웨어") || queryCombined.includes("mft");
  const isOpenSm = queryCombined.includes("opensm") || queryCombined.includes("subnet manager") || queryCombined.includes("서브넷");
  const isUfm = queryCombined.includes("ufm") || queryCombined.includes("user management") || queryCombined.includes("계정");

  let synthesizedMarkdown = `### 📚 [지식베이스 검색 결과]\n\n`;
  synthesizedMarkdown += `등록된 기술 매뉴얼을 분석하여 핵심 구성 절차와 명령어를 요약했습니다.\n\n`;

  // Excerpts are hidden from the final answer to prevent UI clutter and website noise.
  // The UI already displays the sources as chips via `matchedSources`.

  // Actionable engineer tips
  if (isLacpLag) {
    synthesizedMarkdown += `**💡 엔지니어 추천 점검 팁 (LACP/LAG):**\n`;
    synthesizedMarkdown += `- \`net show interface bond1\` 명령어로 LACP 파트너 상태(State) 및 멤버 포트(swp1, swp2)의 정상 바인딩 여부를 확인하십시오.\n`;
    synthesizedMarkdown += `- 양단 스위치 간 MTU 불일치 및 LACP Rate(fast/slow) 설정을 상호 점검하세요.\n\n`;
  } else if (isVxlanEvpn) {
    synthesizedMarkdown += `**💡 엔지니어 추천 점검 팁 (EVPN 멀티호밍):**\n`;
    synthesizedMarkdown += `- \`net show evpn es\` 및 \`net show evpn mac\` 명령어로 양쪽 리프 스위치의 ESI 및 MAC 주소 동기화 상태를 확인하십시오.\n\n`;
  } else if (isIbStat || isOpenSm) {
    synthesizedMarkdown += `**💡 엔지니어 추천 점검 팁 (InfiniBand):**\n`;
    synthesizedMarkdown += `- \`ibstat\` 출력에서 State가 \`Active\`, Physical state가 \`LinkUp\`인지 확인하십시오. \`Initializing\` 상태인 경우 서브넷 매니저(\`systemctl status opensm\`) 동작을 점검해야 합니다.\n\n`;
  } else if (isFirmwareMst) {
    synthesizedMarkdown += `**💡 엔지니어 추천 점검 팁 (Mellanox Firmware):**\n`;
    synthesizedMarkdown += `- 어댑터가 인식되지 않을 때는 \`mst start\`로 드라이버를 로드한 후 \`mstflint -d <PCI_ADDR> q\`로 펌웨어 쿼리를 실행하십시오.\n\n`;
  }

  return {
    answer: synthesizedMarkdown.trim(),
    matchedSources
  };
}

// AI Summarization & Event Extraction Logic
async function processEmailWithAI(subject: string, body: string, dateReceived: string, retries = 3, initialDelay = 1500) {
  let ai: any = null;
  let initErrorMsg = "";
  try {
    ai = getGeminiClient();
  } catch (err: any) {
    initErrorMsg = err.message;
    console.warn("[Gemini API Init] Using direct fallback due to missing key:", initErrorMsg);
  }
  
  // Format the Custom Knowledge Base context to perform high-precision RAG lookups
  const db = readDb();
  const knowledgeDocs = db.knowledgeBase || [];
  
  // Use our high-precision scoring search engine to retrieve the most relevant documents for the query
  const matchedDocsForGemini = searchKnowledgeBase(subject, body, knowledgeDocs);
  
  const lowerSubject = (subject || "").toLowerCase();
  const lowerBody = (body || "").toLowerCase();
  const lowerCombined = `${lowerSubject} ${lowerBody}`;

  const technicalKeywords = [
    "cumulus", "cl-net", "lacp", "bonding", "bond", "vlan", "vxlan", "vxlans", "bridge", "스위치", "switch",
    "infiniband", "인피니밴드", "ibstat", "ibnetdiscover", "opensm", "ndr", "hdr", "mstflint", "펌웨어", "firmware", "mellanox", "hca", "port", "guid", "큐물러스",
    "ufm", "ufm-sdn", "nvidia-sm", "user-management", "appliance", "fabric", "manager", "lag", "LAG"
  ];

  const hasTechnicalKeyword = technicalKeywords.some(kw => lowerCombined.includes(kw));
  const isTechnicalRelated = hasTechnicalKeyword || matchedDocsForGemini.length > 0;

  // Use precisely retrieved docs if available
  const ragDocsToUse = isTechnicalRelated
    ? (matchedDocsForGemini.length > 0 ? matchedDocsForGemini : (knowledgeDocs.length <= 5 ? knowledgeDocs : []))
    : [];

  const kbContext = ragDocsToUse.length > 0 ? ragDocsToUse.map((doc: any) => {
    return `[문서 ID: ${doc.id}]\n카테고리: ${doc.category}\n제목: ${cleanSourceTitle(doc.title || "")}\n태그: ${(doc.tags || []).join(", ")}\n내용:\n${cleanDocumentForRag(doc.content || "")}`;
  }).join("\n\n=========================================\n\n") : "현재 메일 본문이 인피니밴드, UFM, 큐물러스 스위치 등 등록된 기술 지식베이스와 무관하여 RAG 검색이 트리거되지 않았습니다. 지식 창고 문서가 제공되지 않습니다.";

  // Parse incoming date and convert it to Seoul local date/time so Gemini has accurate KST context
  const parsedDate = dateReceived ? new Date(dateReceived) : new Date();
  const anchorDateSeoul = getSeoulLocalISOString(isNaN(parsedDate.getTime()) ? new Date() : parsedDate);

  const isReply = checkIfReply(subject, body);
  const processedBody = isReply ? cleanReplyBody(body) : body;

  let replyContextMessage = "";
  if (isReply) {
    replyContextMessage = `
CRITICAL DIRECTIVE: This email is a REPLY or part of an EMAIL THREAD. 
The body contains quoted older conversation history below the most recent response.
You MUST prioritize and extract coordinates/details ONLY from the MOST RECENT message at the very top.
Ignore older proposed dates, old event summaries, or times mentioned in quoted email headers/history below.
If there is no specific new event scheduled in this recent reply, register it as a Mailing Summary (has_event = false) and make sure the summary title is prefixed with '[회신요약] ' instead of '[요약] '.
`;
  }

  let forceRagInstruction = "";
  if (isTechnicalRelated && matchedDocsForGemini.length > 0) {
    forceRagInstruction = `
CRITICAL FORCE DIRECTIVE:
The query matched relevant documents in our local Knowledge Base or contains explicit network/infrastructure technical keywords with matching document context.
Therefore, set "ragAnswer.triggered" to TRUE.
Match the closest documents in the Knowledge Base, include them in "matchedSources" by their clean titles, and draft a high-fidelity, comprehensive Korean help/technical guide in "ragAnswer.answer" strictly using the provided documents context. Include step-by-step commands and troubleshooting notes.
`;
  } else {
    forceRagInstruction = `
CRITICAL FORCE DIRECTIVE:
There are NO matching documents in our local Knowledge Base for this query or email content.
Set "ragAnswer.triggered" to TRUE, set "ragAnswer.answer" EXACTLY to "RAG 검색 결과 관련 내용이 없습니다.", and set "ragAnswer.matchedSources" to [].
`;
  }

  const systemInstruction = `You are an expert personal scheduling assistant and technical RAG (Retrieval-Augmented Generation) lookup system localized for users in the Asia/Seoul (Korea Standard Time) timezone. 
Analyze the parsed email subject and body to extract calendar event details and check if there are any technical questions about network infrastructures.

CALENDAR EVENT EXTRACTION DIRECTIVE:
You MUST analyze the email subject and body to determine if it contains a specific scheduled event (such as a meeting, appointment, flight, deadline, conference, webinar, dinner, class, etc.).
- If it HAS an event/schedule: Set has_event = true. Extract the exact event title, start_time, end_time, location, and a clear, high-quality Korean summary of the email content and schedule context in description.
- If it DOES NOT have an event/schedule: Set has_event = false. Summarize the email content concisely into description, and set title to a brief title prefixed with '[메일요약] '.

Anchor date and Timezone configuration:
The email was received on: ${anchorDateSeoul} (located in Asia/Seoul local timezone, UTC+9).
ALL relative date calculations (like "today", "tomorrow", "tonight", "next Monday", "in 2 hours", "next month") MUST be computed relative to this local Seoul anchor date & time.
All generated start_time and end_time values MUST be output in standard local ISO 8601 format corresponding to the Seoul local timezone (KST). If has_event is false, output start_time and end_time as the Seoul local received date '${anchorDateSeoul.substring(0, 10)}' (YYYY-MM-DD format). Do not append 'Z', offsets, or secondary timezones.
If specific hours or durations are not specified, select appropriate defaults (e.g., all-day event or 1-hour duration). Ensure the end_time is strictly after the start_time.
${replyContextMessage}

KNOWLEDGE BASE & RAG LOOKUP DIRECTIVE (NotebookLM Style):
You are equipped with a local Knowledge Base containing specific server/network documentation:
-----------------------------------------
${kbContext || "현재 등록된 지식 창고 문서가 없습니다."}
-----------------------------------------

If the query or body contains any keyword or phrase relating to "Cumulus Linux" (or "cl-net", "LACP", "Bonding", "VLAN bridge", "VXLAN", "vxlan", "스위치", "bridge", "큐물러스") or "InfiniBand" (or "인피니밴드", "ibstat", "ibnetdiscover", "openSM", "NDR", "HDR", "mstflint", "펌웨어") or "UFM" (or "Unified Fabric Manager", "User Management", "NVIDIA UFM-SDN", "Mellanox"):
You MUST perform local RAG:
1. Set ragAnswer.triggered = true.
2. Search through the Knowledge Base above. Cite and match the relevant articles by clean title inside "matchedSources".
3. Formulate a comprehensive, highly professional, precise technical response in Korean inside "ragAnswer.answer" strictly utilizing the matching details. Include step-by-step diagnostic procedures, exact command lines from the documents, and configurations.
4. Even if it's a short keyword search, search query, or topic name, you MUST treat it as a lookup query, set triggered to true, and output the relevant guide sections in Korean.
5. If there is absolutely no mention or relevance to network/server topics, set ragAnswer.triggered = false.
6. RAG 답변(answer) 내에는 "출처:" 와 같은 출처 표기를 절대 포함하지 마세요. 출처는 오직 matchedSources 배열에만 담아야 합니다. 웹페이지 메뉴 등 잡음은 모두 제거하고 순수 기술 가이드만 작성하세요.

${forceRagInstruction}
`;

  let lastError: any = null;
  const modelsToTry = ["gemini-3.6-flash", "gemini-3.7-flash", "gemini-flash-latest"];

  if (ai) {
    for (const modelName of modelsToTry) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model: modelName,
            contents: `Subject: ${subject}\n\nBody:\n${processedBody}`,
            config: {
              systemInstruction,
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  has_event: {
                    type: Type.BOOLEAN,
                    description: "True if the email contains a specific, pre-scheduled calendar event/appointment. False if it is a general message, discussion, newsletter, or update to be logged/summarized."
                  },
                  title: {
                    type: Type.STRING,
                    description: "Title of the calendar event. If has_event is true, extract the actual title. If has_event is false, output a succinct summary title prefixed with '[요약] ' (e.g., '[요약] 프로젝트 업데이트')."
                  },
                  start_time: {
                    type: Type.STRING,
                    description: "ISO 8601 string of the start of the event. If has_event is false, set it EXACTLY to the received date in YYYY-MM-DD format (e.g., '" + anchorDateSeoul.substring(0, 10) + "')."
                  },
                  end_time: {
                    type: Type.STRING,
                    description: "ISO 8601 string of the end of the event. If has_event is false, set it EXACTLY to the received date in YYYY-MM-DD format (e.g., '" + anchorDateSeoul.substring(0, 10) + "')."
                  },
                  is_all_day: {
                    type: Type.BOOLEAN,
                    description: "Whether the event should be structured as an all-day event. If has_event is false, MUST be true."
                  },
                  description: {
                    type: Type.STRING,
                    description: "Short concise summary of the email content, including any important context, links, or follow-up items."
                  },
                  location: {
                    type: Type.STRING,
                    description: "Extracted meeting location (e.g. Zoom link, physical address, room name). Leave empty if none specified."
                  },
                  reasoning: {
                    type: Type.STRING,
                    description: "A single sentence explaining why this email was categorized as having an event or being summarized."
                  },
                  ragAnswer: {
                    type: Type.OBJECT,
                    properties: {
                      triggered: {
                        type: Type.BOOLEAN,
                        description: "Set to true if the email asks technical questions or mentions topics covered in the Knowledge Base. Set to false otherwise."
                      },
                      answer: {
                        type: Type.STRING,
                        description: "Succinct, professional Korean technical response drafted strictly based on the matched Knowledge Base documents. Citations and shell commands should be included. Empty string if triggered is false."
                      },
                      matchedSources: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description: "List of document titles referenced to answer the question. Empty array if triggered is false."
                      }
                    },
                    required: ["triggered", "answer", "matchedSources"]
                  }
                },
                required: ["has_event", "title", "start_time", "end_time", "is_all_day", "description", "reasoning", "ragAnswer"]
              }
            }
          });

          const parsed = JSON.parse(response.text.trim());
          if (parsed && parsed.ragAnswer) {
            if (!isTechnicalRelated || matchedDocsForGemini.length === 0 || !parsed.ragAnswer.answer || parsed.ragAnswer.answer.trim() === "" || parsed.ragAnswer.answer.includes("관련 내용이 없습니다") || parsed.ragAnswer.answer.includes("검색이 트리거되지 않았습니다")) {
              parsed.ragAnswer.triggered = true;
              parsed.ragAnswer.answer = "RAG 검색 결과 관련 내용이 없습니다.";
              parsed.ragAnswer.matchedSources = [];
            } else {
              parsed.ragAnswer.triggered = true;
              if (Array.isArray(parsed.ragAnswer.matchedSources)) {
                parsed.ragAnswer.matchedSources = Array.from(
                  new Set(parsed.ragAnswer.matchedSources.map(formatShortSourceTitle))
                ).filter(Boolean);
              }
            }
          }
          return parsed;
        } catch (error: any) {
          lastError = error;
          const errStr = (error.message || "").toLowerCase();
          const isRateLimit = errStr.includes("429") || errStr.includes("quota") || errStr.includes("rate") || errStr.includes("exhausted");
          
          console.error(`AI processing attempt ${attempt} with ${modelName} failed: ${error.message}`);
          
          if (attempt < retries && !isRateLimit) {
            const delayTime = initialDelay * Math.pow(2, attempt - 1) + Math.random() * 500;
            await new Promise((resolve) => setTimeout(resolve, delayTime));
          } else {
            break; // Move to next model or fallback
          }
        }
      }
    }
  } else {
    lastError = new Error(initErrorMsg || "Gemini Client configuration not complete.");
  }

  console.warn("[Gemini API Fallback] Deploying high-precision technical synthesizer fallback due to API error/quota limits.");
  
  // High-precision local keyword scoring-matching engine fallback with structured synthesizer
  const matchedDocs = searchKnowledgeBase(subject, body, knowledgeDocs);
  const synthesized = synthesizeRagAnswer(subject, body, matchedDocs);
  
  return {
    has_event: false,
    title: `[로컬 지능 요약] ${subject}`,
    start_time: anchorDateSeoul.substring(0, 10),
    end_time: anchorDateSeoul.substring(0, 10),
    is_all_day: true,
    description: `[수신 메일 요약] 내용:\n${body.substring(0, 400)}${body.length > 400 ? "..." : ""}`,
    location: "",
    reasoning: "지식베이스 검색 및 실시간 기술 매뉴얼 매칭을 수행하여 정밀 답변을 생성했습니다.",
    ragAnswer: {
      triggered: true,
      answer: synthesized.answer,
      matchedSources: synthesized.matchedSources
    }
  };
}

// Robust retrieval utility to extract high-yield technical and descriptive keywords
function extractSearchKeywords(query: string): string[] {
  const text = query.toLowerCase();
  // Split using typical delimiters
  const rawWords = text.split(/[\s,.\-()[\]{}|<>:;?"'/]+/);
  const keywords = new Set<string>();

  for (const rawWord of rawWords) {
    let word = rawWord.trim();
    if (!word) continue;

    // Filter out common Korean grammatical end-particles to reach clean noun stems
    if (word.length > 1) {
      word = word.replace(/(은|는|이|가|을|를|의|에|와|과|로|으로|에서|서|야|이야|며|하며|해서|해줘|정리|요|함|함니다|입니다|하나요|인가요|대해|대해서|관련|설정)$/, "");
    }

    if (word.length <= 1) {
      if (!/\d/.test(word)) { // Keep numbers like "5" or "16"
        continue;
      }
    }

    // Filter out typical non-technical boilerplate stop words
    const stopWords = new Set(["관련", "설정", "정리해줘", "해줘", "봅니다", "가이드", "질문", "답변", "방법", "절차", "정보", "확인", "정상적이지", "않아", "결과", "테스트", "조회"]);
    if (stopWords.has(word)) {
      continue;
    }

    keywords.add(word);
  }

  return Array.from(keywords);
}

// Scored-based Search Engine for High-Fidelity RAG matching
function searchKnowledgeBase(subject: string, body: string, docs: any[]): any[] {
  const query = `${subject} ${body}`.toLowerCase().trim();
  const rawKeywords = extractSearchKeywords(query);

  if (rawKeywords.length === 0) {
    return [];
  }

  // Synonym expansion for network/infrastructure domains
  const expandedKeywords = new Set<string>();
  rawKeywords.forEach(kw => {
    expandedKeywords.add(kw);

    // Expand LAG/LACP/Bonding synonyms
    if (kw === "lag" || kw === "lag룩업" || kw === "lag설정" || kw === "래그" || kw === "랙" || kw === "링크애그리게이션" || kw === "애그리게이션") {
      expandedKeywords.add("lag");
      expandedKeywords.add("lacp");
      expandedKeywords.add("bonding");
      expandedKeywords.add("bond");
    }
    if (kw === "lacp" || kw === "bonding" || kw === "bond" || kw === "본딩" || kw === "본드") {
      expandedKeywords.add("lag");
      expandedKeywords.add("lacp");
      expandedKeywords.add("bonding");
      expandedKeywords.add("bond");
    }
    // Expand other common networking term translations
    if (kw === "큐물러스" || kw === "cumulus" || kw === "큐물러스리눅스") {
      expandedKeywords.add("cumulus");
      expandedKeywords.add("큐물러스");
    }
    if (kw === "인피니밴드" || kw === "infiniband" || kw === "아이비") {
      expandedKeywords.add("infiniband");
      expandedKeywords.add("인피니밴드");
    }
    if (kw === "브릿지" || kw === "브리지" || kw === "bridge") {
      expandedKeywords.add("bridge");
      expandedKeywords.add("브릿지");
      expandedKeywords.add("브리지");
    }
    if (kw === "스위치" || kw === "switch") {
      expandedKeywords.add("switch");
      expandedKeywords.add("스위치");
    }
    if (kw === "포트" || kw === "port") {
      expandedKeywords.add("port");
      expandedKeywords.add("포트");
    }
    if (kw === "인터페이스" || kw === "interface") {
      expandedKeywords.add("interface");
      expandedKeywords.add("인터페이스");
    }
  });

  const keywordsArray = Array.from(expandedKeywords);

  const scoredDocs = docs.map(docItem => {
    let score = 0;
    const title = cleanSourceTitle(docItem.title || "").toLowerCase();
    const content = (docItem.content || "").toLowerCase();
    const tags = (docItem.tags || []).map((t: any) => String(t).toLowerCase());
    const category = (docItem.category || "").toLowerCase();

    // Iterate through key search terms and accumulate search signal strength
    keywordsArray.forEach(kw => {
      // 1. Tag matches (high priority)
      tags.forEach((tag: string) => {
        if (tag === kw) {
          score += 30;
        } else if (tag.includes(kw) || kw.includes(tag)) {
          if (/^[a-zA-Z0-9_-]+$/.test(tag) && /^[a-zA-Z0-9_-]+$/.test(kw)) {
            if (tag === kw) {
              score += 30;
            } else if ((tag === "vlan-aware" && kw === "vlan") || (tag === "vlan" && kw === "vlan-aware") || (tag === "multi-homing" && kw === "multihoming") || (tag === "multihoming" && kw === "multi-homing")) {
              score += 20;
            } else {
              score += 5;
            }
          } else {
            score += 10;
          }
        }
      });

      // 2. Title matches
      if (title.includes(kw)) {
        score += 20;
        if (title.startsWith(kw)) {
          score += 10;
        }
      }

      // 3. Content matching
      const escapedKw = kw.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      const matches = content.match(new RegExp(escapedKw, 'g'));
      if (matches) {
        score += Math.min(6, matches.length) * 4;
      }
    });

    // 4. Boost significantly if ALL RAW keywords match
    const matchesAllKeywords = rawKeywords.every(kw => {
      const synonyms = [kw];
      if (kw === "lag") synonyms.push("lacp", "bonding", "bond");
      if (kw === "lacp" || kw === "bonding" || kw === "bond" || kw === "본딩") synonyms.push("lag", "lacp", "bonding", "bond");
      if (kw === "큐물러스" || kw === "cumulus") synonyms.push("cumulus", "큐물러스");
      if (kw === "인피니밴드" || kw === "infiniband") synonyms.push("infiniband", "인피니밴드");
      if (kw === "브릿지" || kw === "브리지" || kw === "bridge") synonyms.push("bridge", "브릿지", "브리지");
      
      return synonyms.some(syn => title.includes(syn) || content.includes(syn) || tags.includes(syn) || category.includes(syn));
    });
    if (matchesAllKeywords) {
      score += 40;
    }

    return { docItem, score };
  });

  // Threshold check to prevent returning irrelevant documents (Min score 18)
  const filtered = scoredDocs
    .filter(item => item.score >= 18)
    .sort((a, b) => b.score - a.score);

  // Deduplicate matched docs by clean title
  const seenTitles = new Set<string>();
  const uniqueDocs: any[] = [];
  for (const item of filtered) {
    const key = cleanSourceTitle(item.docItem.title || "").toLowerCase();
    if (!seenTitles.has(key)) {
      seenTitles.add(key);
      uniqueDocs.push(item.docItem);
    }
  }

  return uniqueDocs;
}

// Helper function to format date/time components in Asia/Seoul timezone.
function getSeoulLocalISOString(d: Date): string {
  // Seoul is exactly UTC + 9 hours
  const seoulOffsetMs = 9 * 60 * 60 * 1000;
  const seoulDate = new Date(d.getTime() + seoulOffsetMs);

  const yyyy = seoulDate.getUTCFullYear();
  const mm = String(seoulDate.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(seoulDate.getUTCDate()).padStart(2, "0");
  const hh = String(seoulDate.getUTCHours()).padStart(2, "0");
  const min = String(seoulDate.getUTCMinutes()).padStart(2, "0");
  const sec = String(seoulDate.getUTCSeconds()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}T${hh}:${min}:${sec}`;
}

// Convert any date string (with or without timezone offset) into a Date object representing the correct KST-localized moment.
function parseToSeoulDate(timeStr: string): Date {
  if (!timeStr) return new Date();
  
  const trimmed = timeStr.trim();
  
  // Hand-parse pure date format YYYY-MM-DD to completely avoid local browser engine offset shift
  const matchDateOnly = trimmed.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  if (matchDateOnly) {
    const [, yyyy, mm, dd] = matchDateOnly;
    const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00+09:00`);
    if (!isNaN(d.getTime())) return d;
  }

  // Check if string already contains a timezone offset (Z, +09:00, -0500, etc.)
  const hasOffset = /Z$/i.test(trimmed) || /[+-]\d{2}(:?\d{2})?$/.test(trimmed);
  
  if (hasOffset) {
    const parsed = new Date(trimmed);
    return isNaN(parsed.getTime()) ? new Date() : parsed;
  }
  
  // If timezone-naive, treat the input as being in the Asia/Seoul (+09:00) local timezone.
  let normalized = trimmed.replace(/\s+/, "T");
  
  if (!normalized.includes("T")) {
    // If length is enough, fallback to date midnight
    if (normalized.length >= 10) {
      normalized = `${normalized.substring(0, 10)}T00:00:00`;
    } else {
      return new Date();
    }
  }
  
  // Now append Seoul timezone offset (+09:00)
  const withOffset = normalized.includes("+09:00") ? normalized : `${normalized}+09:00`;
  const parsed = new Date(withOffset);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }
  
  return new Date();
}

// Helper function to format date/time payload for Google Calendar
function formatGoogleCalendarTime(timeStr: string, isAllDay: boolean) {
  const parsedDate = parseToSeoulDate(timeStr);
  const localISO = getSeoulLocalISOString(parsedDate);
  const datePart = localISO.substring(0, 10);
  
  if (isAllDay) {
    // For all-day events, use "YYYY-MM-DD" and do NOT include timeZone field as per Google API spec.
    return { date: datePart };
  }

  // To prevent any potential "Missing time zone definition" or timezone mismatch errors, 
  // we provide a fully-qualified RFC 3339 offset string (e.g., "YYYY-MM-DDTHH:mm:ss+09:00").
  // By sending the timezone offset in the string (+09:00 representing KST/Seoul), we can safely
  // omit the redundant/conflict-prone 'timeZone' field. This eliminates any possible validation
  // conflicts between ISO UTC Zulu suffixes and external timezone specifications.
  return {
    dateTime: `${localISO}+09:00`
  };
}

// Function to register event on Google Calendar
async function createGoogleCalendarEvent(accessToken: string, calendarId: string, eventData: any) {
  const { title, start_time, end_time, is_all_day, description, location, reasoning } = eventData;

  const isAllDayEvent = !!is_all_day;
  let startSpec = formatGoogleCalendarTime(start_time, isAllDayEvent);
  let endSpec = formatGoogleCalendarTime(end_time, isAllDayEvent);

  // If it is an all-day event, Google Calendar API end date is exclusive.
  // If start.date and end.date are the same, we MUST increment the end.date by 1 day to ensure non-zero duration.
  if (isAllDayEvent && startSpec.date && endSpec.date) {
    if (startSpec.date === endSpec.date) {
      const startDateObj = new Date(`${startSpec.date}T00:00:00Z`);
      const nextDateObj = new Date(startDateObj.getTime() + 24 * 60 * 60 * 1000);
      const yyyy = nextDateObj.getUTCFullYear();
      const mm = String(nextDateObj.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(nextDateObj.getUTCDate()).padStart(2, "0");
      endSpec = { date: `${yyyy}-${mm}-${dd}` };
    }
  }

  let descExtended = `${description}\n\n---\nClassification Reason: ${reasoning}`;

  if (eventData.attachmentNames && eventData.attachmentNames.length > 0) {
    descExtended += `\n\n📎 첨부파일: ` + eventData.attachmentNames.join(", ");
  }

  if (eventData.ragAnswer && eventData.ragAnswer.answer) {
    if (eventData.ragAnswer.answer === "RAG 검색 결과 관련 내용이 없습니다.") {
      descExtended += `\n\n=========================================\n[💡 RAG 지식 검색 결과]\nRAG 검색 결과 관련 내용이 없습니다.`;
    } else {
      descExtended += `\n\n=========================================\n[💡 RAG 기술 지식 답변 국문 요약]\n${eventData.ragAnswer.answer}`;
    }
  }

  const bodyPayload: any = {
    summary: title,
    description: descExtended,
    start: startSpec,
    end: endSpec,
  };

  if (location) {
    bodyPayload.location = location;
  }

  console.log("====================================================");
  console.log("Google Calendar Request Payload:");
  console.log(JSON.stringify(bodyPayload, null, 2));
  console.log("====================================================");

  // Use fetch to post to Google Calendar API
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bodyPayload),
  });

  if (!response.ok) {
    const errText = await response.text();
    let apiErrorMsg = errText;
    try {
      const parsedErr = JSON.parse(errText);
      if (parsedErr.error && parsedErr.error.message) {
        apiErrorMsg = parsedErr.error.message;
      }
    } catch (e) {}
    throw new Error(`[Start: ${JSON.stringify(startSpec)}, End: ${JSON.stringify(endSpec)}] Google Calendar API Error: ${apiErrorMsg}`);
  }

  return await response.json();
}

// ==================== API ENDPOINTS ====================

// Retrieve stats, settings, token status, and credentials schema
app.get("/api/auth/status", async (req, res) => {
  try {
    const db = readDb();
    const creds = db.credentials || {};
    
    let isGoogleConnected = false;
    let remainingTime = 0;

    if (creds.accessToken) {
      const token = await getValidAccessToken();
      if (token) {
        isGoogleConnected = true;
        if (creds.tokenExpiry) {
          remainingTime = Math.max(0, Math.floor((creds.tokenExpiry - Date.now()) / 1000));
        }
      }
    }

    res.json({
      googleConnected: isGoogleConnected,
      userEmail: creds.userEmail || "",
      clientIdConfigured: !!creds.clientId,
      clientSecretConfigured: !!creds.clientSecret,
      targetCalendarId: db.settings?.targetCalendarId || "primary",
      remainingTime,
      backupCredentials: {
        clientId: creds.clientId || "",
        clientSecret: creds.clientSecret || "",
        accessToken: creds.accessToken || "",
        refreshToken: creds.refreshToken || "",
        tokenExpiry: creds.tokenExpiry || 0,
        userEmail: creds.userEmail || ""
      }
    });
  } catch (err: any) {
    console.error("Error in /api/auth/status route:", err);
    res.status(500).json({ error: "Internal Server Error", message: err.message });
  }
});

// Sync/Restore credentials from client localStorage backup (e.g. after container restart or replica scale-out)
app.post("/api/auth/sync", async (req, res) => {
  const { clientId, clientSecret, accessToken, refreshToken, tokenExpiry, userEmail, targetCalendarId } = req.body;
  const db = readDb();
  
  let updated = false;
  if (!db.credentials) db.credentials = {};
  
  if (clientId && clientId !== db.credentials.clientId) {
    db.credentials.clientId = clientId;
    updated = true;
  }
  if (clientSecret && clientSecret !== db.credentials.clientSecret) {
    db.credentials.clientSecret = clientSecret;
    updated = true;
  }
  if (accessToken && accessToken !== db.credentials.accessToken) {
    db.credentials.accessToken = accessToken;
    updated = true;
  }
  if (refreshToken && refreshToken !== db.credentials.refreshToken) {
    db.credentials.refreshToken = refreshToken;
    updated = true;
  }
  if (tokenExpiry && Number(tokenExpiry) !== db.credentials.tokenExpiry) {
    db.credentials.tokenExpiry = Number(tokenExpiry);
    updated = true;
  }
  if (userEmail && userEmail !== db.credentials.userEmail) {
    db.credentials.userEmail = userEmail;
    updated = true;
  }
  if (targetCalendarId) {
    if (!db.settings) db.settings = {};
    if (targetCalendarId !== db.settings.targetCalendarId) {
      db.settings.targetCalendarId = targetCalendarId;
      updated = true;
    }
  }

  if (updated) {
    await writeDb(db);
  }

  res.json({ success: true, message: "Credentials synchronized successfully." });
});

// Configure Custom Credentials
app.post("/api/auth/configure", async (req, res) => {
  const { clientId, clientSecret, targetCalendarId } = req.body;
  const db = readDb();
  
  if (!db.credentials) db.credentials = {};
  if (clientId !== undefined) db.credentials.clientId = clientId;
  if (clientSecret !== undefined) db.credentials.clientSecret = clientSecret;
  if (targetCalendarId !== undefined) {
    if (!db.settings) db.settings = {};
    db.settings.targetCalendarId = targetCalendarId;
  }

  await writeDb(db);
  res.json({ success: true, message: "Credentials and settings configured successfully!" });
});

// Manual Access Token insertion (Bypass OAuth)
app.post("/api/auth/save-token", async (req, res) => {
  const { accessToken, expires_in, userEmail } = req.body;
  if (!accessToken) {
    return res.status(400).json({ error: "Access token is required" });
  }

  const db = readDb();
  db.credentials = {
    ...db.credentials,
    accessToken,
    refreshToken: db.credentials.refreshToken || "", // preserve if exists
    tokenExpiry: Date.now() + (expires_in || 3600) * 1000,
    userEmail: userEmail || "manual-user@google.com"
  };

  await writeDb(db);
  res.json({ success: true, message: "Manually authenticated successfully!" });
});

// Initiate standard Google OAuth redirect
app.get("/api/auth/google", (req, res) => {
  const db = readDb();
  const clientId = db.credentials?.clientId || process.env.GOOGLE_CLIENT_ID;
  
  if (!clientId) {
    return res.status(400).send("Google Client ID is missing. Please configure it in settings or workspace secrets.");
  }

  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.get("host");
  const appUrl = `${protocol}://${host}`;
  const redirectUri = `${appUrl}/api/auth/google/callback`;
  const scopes = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile"
  ].join(" ");

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes,
    access_type: "offline",
    prompt: "consent"
  }).toString();

  res.redirect(authUrl);
});

// Google OAuth callback
app.get("/api/auth/google/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.redirect("/?auth_status=error&message=No+code+provided+by+Google");
  }

  const db = readDb();
  const clientId = db.credentials?.clientId || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = db.credentials?.clientSecret || process.env.GOOGLE_CLIENT_SECRET;
  
  if (!clientId || !clientSecret) {
    return res.redirect("/?auth_status=error&message=Missing+Client+Credentials+on+Server");
  }

  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.get("host");
  const appUrl = `${protocol}://${host}`;
  const redirectUri = `${appUrl}/api/auth/google/callback`;

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code: code as string,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok) {
      throw new Error(tokens.error_description || tokens.error || "Token exchange failed");
    }

    // Capture User Profile info to show which email is logged in
    let userEmail = "google-user@gmail.com";
    try {
      const profileResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (profileResponse.ok) {
        const profile = await profileResponse.json();
        userEmail = profile.email || userEmail;
      }
    } catch (e) {
      console.error("Error fetching user profile:", e);
    }

    db.credentials = {
      clientId,
      clientSecret,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || db.credentials.refreshToken || "",
      tokenExpiry: Date.now() + (tokens.expires_in || 3600) * 1000,
      userEmail,
    };

    await writeDb(db);
    
    // Modern iframe postMessage response to cleanly alert parent window and close popup
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Google Authentication Success</title>
          <meta charset="utf-8" />
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; padding: 50px; background-color: #f8fafc; color: #334155; }
            .spinner { border: 4px solid rgba(0,0,0,.1); width: 36px; height: 36px; border-radius: 50%; border-left-color: #4f46e5; animation: spin 1s linear infinite; margin: 0 auto 20px; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            h2 { color: #1e1b4b; }
          </style>
        </head>
        <body>
          <div class="spinner"></div>
          <h2>구글 로그인 연동 완료!</h2>
          <p>내역 동기화 및 캘린더 연동이 정상 완료되었습니다. 이 창은 자동으로 닫힙니다.</p>
          <script>
            try {
              if (window.opener) {
                window.opener.postMessage({ type: "OAUTH_AUTH_SUCCESS" }, "*");
                setTimeout(function() { window.close(); }, 1000);
              } else {
                window.location.href = "/?auth_status=success";
              }
            } catch (err) {
              console.error(err);
              window.location.href = "/?auth_status=success";
            }
          </script>
        </body>
      </html>
    `);
  } catch (err: any) {
    console.error("OAuth callback error:", err);
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Google Authentication Failed</title>
          <meta charset="utf-8" />
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; padding: 50px; background-color: #fff1f2; color: #991b1b; }
            h2 { color: #9f1239; }
          </style>
        </head>
        <body>
          <h2>구글 로그인 연동 실패</h2>
          <p>오류 내용: ${err.message || "인증 교환 실패"}</p>
          <script>
            try {
              if (window.opener) {
                window.opener.postMessage({ type: "OAUTH_AUTH_FAILED", error: ${JSON.stringify(err.message || "Failed to exchange code")} }, "*");
                setTimeout(function() { window.close(); }, 3000);
              } else {
                window.location.href = "/?auth_status=error&message=" + encodeURIComponent(${JSON.stringify(err.message || "Failed to exchange code")});
              }
            } catch (e) {
              window.location.href = "/?auth_status=error&message=" + encodeURIComponent(${JSON.stringify(err.message || "Failed to exchange code")});
            }
          </script>
        </body>
      </html>
    `);
  }
});

// Log out Google connection
app.post("/api/auth/clear", async (req, res) => {
  const db = readDb();
  db.credentials.accessToken = "";
  db.credentials.refreshToken = "";
  db.credentials.tokenExpiry = 0;
  db.credentials.userEmail = "";
  await writeDb(db);
  res.json({ success: true, message: "Logged out / Disconnected successfully!" });
});

// Completely reset custom client credentials
app.post("/api/auth/reset-credentials", async (req, res) => {
  const db = readDb();
  db.credentials = {
    clientId: "",
    clientSecret: "",
    accessToken: "",
    refreshToken: "",
    tokenExpiry: 0,
    userEmail: ""
  };
  await writeDb(db);
  res.json({ success: true, message: "OAuth Client ID & Client Secret have been reset!" });
});

// Retrieve Google Calendar List
app.get("/api/calendars", async (req, res) => {
  const token = await getValidAccessToken();
  if (!token) {
    return res.status(401).json({ error: "Not authenticated with Google calendar." });
  }

  try {
    const response = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch calendars: ${await response.text()}`);
    }

    const data = await response.json();
    const calendars = (data.items || []).map((cal: any) => ({
      id: cal.id,
      summary: cal.summary,
      primary: !!cal.primary,
    }));

    res.json({ calendars });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch History logs
app.get("/api/history", (req, res) => {
  const db = readDb();
  res.json({ history: db.history || [] });
});

// Clear Individual or All History Logs
app.post("/api/history/delete", async (req, res) => {
  const { id, clearAll } = req.body;
  const db = readDb();

  if (clearAll) {
    if (firestoreDb) {
      try {
        console.log("[Firebase] Bulk deleting all history subcollection items from Firestore...");
        const historyCollectionRef = collection(firestoreDb, "app_state", "main", "history");
        const querySnap = await getDocs(historyCollectionRef);
        for (const docSnap of querySnap.docs) {
          const docRef = doc(firestoreDb, "app_state", "main", "history", docSnap.id);
          await deleteDoc(docRef);
        }
      } catch (err) {
        console.warn("[Firebase] Failed to delete history items from subcollection:", err);
      }
    }
    db.history = [];
  } else if (id) {
    if (firestoreDb) {
      try {
        const docRef = doc(firestoreDb, "app_state", "main", "history", id);
        await deleteDoc(docRef);
        console.log(`[Firebase] Successfully deleted history item ${id} from Firestore.`);
      } catch (err) {
        console.warn(`[Firebase] Failed to delete history item ${id} from Firestore:`, err);
      }
    }
    db.history = db.history.filter((item: any) => item.id !== id);
  }

  await writeDb(db);
  res.json({ success: true, message: "History modified successfully." });
});

// Retrieve custom knowledge base documents (RAG)
app.get("/api/knowledge-base", async (req, res) => {
  if (lastFirestoreError && firestoreDb) {
    // Attempt automatic background recovery sync if an error was recorded
    await syncFromFirestore();
  }
  const db = readDb();
  res.json({ 
    knowledgeBase: db.knowledgeBase || [],
    sourceUrls: db.sourceUrls || [],
    firestoreError: lastFirestoreError
  });
});

// Explicit retry sync endpoint for RAG Workspace
app.post("/api/knowledge-base/retry-sync", async (req, res) => {
  const success = await syncFromFirestore();
  const db = readDb();
  res.json({
    success,
    knowledgeBase: db.knowledgeBase || [],
    sourceUrls: db.sourceUrls || [],
    firestoreError: lastFirestoreError,
    message: success ? "Firestore 클라우드 동기화가 성공적으로 완료되었습니다." : "동기화 실패"
  });
});

// Create or update a RAG source URL
app.post("/api/knowledge-base/sources", async (req, res) => {
  const { url, maxPages, maxDepth, category } = req.body;
  if (!url) {
    return res.status(400).json({ error: "URL is required." });
  }

  const db = readDb();
  if (!db.sourceUrls) db.sourceUrls = [];

  let resolvedUrl = url.trim();
  if (!/^https?:\/\//i.test(resolvedUrl)) {
    resolvedUrl = "https://" + resolvedUrl;
  }

  // Check if already exists based on URL
  const existingIdx = db.sourceUrls.findIndex(
    (item: any) => item.url.toLowerCase() === resolvedUrl.toLowerCase()
  );

  const sourceItem = {
    id: existingIdx !== -1 ? db.sourceUrls[existingIdx].id : `src_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    url: resolvedUrl,
    maxPages: parseInt(maxPages, 10) || 10,
    maxDepth: parseInt(maxDepth, 10) || 2,
    category: category || "Cumulus Linux",
    createdAt: existingIdx !== -1 ? db.sourceUrls[existingIdx].createdAt : new Date().toISOString(),
    lastCrawledAt: existingIdx !== -1 ? db.sourceUrls[existingIdx].lastCrawledAt : undefined,
    count: existingIdx !== -1 ? db.sourceUrls[existingIdx].count : 0
  };

  if (existingIdx !== -1) {
    db.sourceUrls[existingIdx] = sourceItem;
  } else {
    db.sourceUrls.unshift(sourceItem);
  }

  await writeDb(db);
  res.json({ success: true, sourceUrls: db.sourceUrls });
});

// Delete a RAG source URL (and optionally its crawled documents)
app.post("/api/knowledge-base/sources/delete", async (req, res) => {
  const { id, deleteDocs } = req.body;
  if (!id) {
    return res.status(400).json({ error: "Source ID is required." });
  }

  const db = readDb();
  if (!db.sourceUrls) db.sourceUrls = [];

  const targetSource = db.sourceUrls.find((item: any) => item.id === id);
  if (!targetSource) {
    return res.status(404).json({ error: "Source configuration not found." });
  }

  db.sourceUrls = db.sourceUrls.filter((item: any) => item.id !== id);

  let deletedDocCount = 0;
  if (deleteDocs && targetSource.url) {
    try {
      let resolvedUrl = targetSource.url.trim();
      if (!/^https?:\/\//i.test(resolvedUrl)) {
        resolvedUrl = "https://" + resolvedUrl;
      }
      const hostObj = new URL(resolvedUrl);
      const hostname = hostObj.hostname;

      if (db.knowledgeBase) {
        const initialLen = db.knowledgeBase.length;
        const itemsToDelete = db.knowledgeBase.filter((doc: any) => {
          if (!doc.id.startsWith("kb_crawl_")) return false;
          if (doc.sourceUrl) {
            return doc.sourceUrl.toLowerCase().replace(/\/+$/, "") === resolvedUrl.toLowerCase().replace(/\/+$/, "");
          }
          if (doc.content) {
            const match = doc.content.match(/\[출처 URL: ([^\]]+)\]/);
            if (match && match[1]) {
              const cleanDocUrl = match[1].toLowerCase().trim().replace(/\/+$/, "");
              const cleanStartUrl = resolvedUrl.toLowerCase().trim().replace(/\/+$/, "");
              return cleanDocUrl.startsWith(cleanStartUrl) || cleanDocUrl === cleanStartUrl;
            }
          }
          return false;
        });

        db.knowledgeBase = db.knowledgeBase.filter(
          (doc: any) => !itemsToDelete.some((delItem: any) => delItem.id === doc.id)
        );

        deletedDocCount = initialLen - db.knowledgeBase.length;

        // Also bulk-delete from Firestore if configured
        if (firestoreDb && itemsToDelete.length > 0) {
          console.log(`[Firebase] Bulk deleting ${itemsToDelete.length} crawled docs from Firestore subcollection...`);
          for (const item of itemsToDelete) {
            try {
              const docRef = doc(firestoreDb, "app_state", "main", "knowledge_base", item.id);
              await deleteDoc(docRef);
            } catch (fbErr) {
              console.warn(`[Firebase] Error deleting doc ${item.id}:`, fbErr);
            }
          }
        }
      }
    } catch (err) {
      console.error("Error parsing hostname for deletion:", err);
    }
  }

  await writeDb(db);
  res.json({ success: true, sourceUrls: db.sourceUrls, deletedDocCount });
});

// Create or Update a knowledge base document
app.post("/api/knowledge-base", async (req, res) => {
  const { id, title, category, tags, content } = req.body;
  
  if (!title || !category || !content) {
    return res.status(400).json({ error: "Title, category, and content are required." });
  }

  const db = readDb();
  if (!db.knowledgeBase) db.knowledgeBase = [];

  const targetId = id || `kb_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const existingIdx = db.knowledgeBase.findIndex((doc: any) => doc.id === targetId);

  const docItem = {
    id: targetId,
    title,
    category,
    tags: Array.isArray(tags) ? tags.map(t => String(t).trim()).filter(Boolean) : [],
    content,
    updatedAt: new Date().toISOString()
  };

  if (existingIdx !== -1) {
    db.knowledgeBase[existingIdx] = docItem;
  } else {
    db.knowledgeBase.unshift(docItem);
  }

  await writeDb(db);
  res.json({ success: true, docItem });
});

// Delete a knowledge base document
app.post("/api/knowledge-base/delete", async (req, res) => {
  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ error: "Document ID is required." });
  }

  const db = readDb();
  if (db.knowledgeBase) {
    db.knowledgeBase = db.knowledgeBase.filter((doc: any) => doc.id !== id);
    await writeDb(db);
  }

  // Also delete from Firestore subcollection if configured to keep it synced
  if (firestoreDb) {
    try {
      const kbDocRef = doc(firestoreDb, "app_state", "main", "knowledge_base", id);
      await deleteDoc(kbDocRef);
      console.log(`[Firebase] Deleted kb doc ${id} from Firestore subcollection.`);
    } catch (err) {
      console.warn("[Firebase] Error deleting kb doc from Firestore:", err);
    }
  }

  res.json({ success: true, message: "Knowledge document deleted successfully." });
});

// Crawl a specific website and its sub-URLs
app.post("/api/knowledge-base/crawl", async (req, res) => {
  const { url, maxPages, maxDepth, category } = req.body;

  if (!url) {
    return res.status(400).json({ error: "crawling URL is required." });
  }

  // Set up streaming response header
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const sendLog = (data: any) => {
    res.write(JSON.stringify(data) + "\n");
    if (typeof (res as any).flush === "function") {
      (res as any).flush();
    }
  };

  const heartbeat = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
      if (typeof (res as any).flush === "function") {
        (res as any).flush();
      }
    } catch (err) {
      clearInterval(heartbeat);
    }
  }, 4500);

  try {
    let resolvedUrl = url.trim();
    if (!/^https?:\/\//i.test(resolvedUrl)) {
      resolvedUrl = "https://" + resolvedUrl;
    }

    const startUrlObj = new URL(resolvedUrl);
    const allowedHostname = startUrlObj.hostname;
    const allowedOrigin = startUrlObj.origin;

    const pagesToCrawl = Math.min(Math.max(parseInt(maxPages, 10) || 10, 1), 50);
    const depthToCrawl = Math.min(Math.max(parseInt(maxDepth, 10) || 2, 1), 4);
    const docCategory = category?.trim() || "Crawled Web";

    // Pre-register/save source URL settings in DB immediately so the UI is updated dynamically with the new site config
    try {
      const preDb = readDb();
      if (!preDb.sourceUrls) preDb.sourceUrls = [];
      const matchedIdx = preDb.sourceUrls.findIndex((item: any) => {
        return item.url.toLowerCase().replace(/\/+$/, "") === startUrlObj.href.toLowerCase().replace(/\/+$/, "");
      });

      if (matchedIdx !== -1) {
        preDb.sourceUrls[matchedIdx].lastCrawledAt = new Date().toISOString();
        preDb.sourceUrls[matchedIdx].maxPages = pagesToCrawl;
        preDb.sourceUrls[matchedIdx].maxDepth = depthToCrawl;
        preDb.sourceUrls[matchedIdx].category = docCategory;
      } else {
        preDb.sourceUrls.unshift({
          id: `src_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          url: startUrlObj.href,
          maxPages: pagesToCrawl,
          maxDepth: depthToCrawl,
          category: docCategory,
          createdAt: new Date().toISOString(),
          lastCrawledAt: new Date().toISOString(),
          count: 0
        });
      }
      await writeDb(preDb);
    } catch (preErr) {
      console.error("Failed to pre-register source URL in local DB:", preErr);
    }

    sendLog({ type: "start", message: `🕷️ Web crawler initialized. Target: ${startUrlObj.href} (Max pages: ${pagesToCrawl}, Max depth: ${depthToCrawl})` });

    // Clean up older documents of this specific source before crawling to prevent duplication/accumulation
    try {
      const dbCurrent = readDb();
      const itemsToDelete = (dbCurrent.knowledgeBase || []).filter((doc: any) => {
        if (!doc.id || !doc.id.startsWith("kb_crawl_")) return false;
        if (doc.sourceUrl) {
          return doc.sourceUrl.toLowerCase().replace(/\/+$/, "") === startUrlObj.href.toLowerCase().replace(/\/+$/, "");
        }
        if (doc.content) {
          const match = doc.content.match(/\[출처 URL: ([^\]]+)\]/);
          if (match && match[1]) {
            const cleanDocUrl = match[1].toLowerCase().trim().replace(/\/+$/, "");
            const cleanStartUrl = startUrlObj.href.toLowerCase().trim().replace(/\/+$/, "");
            return cleanDocUrl.startsWith(cleanStartUrl) || cleanDocUrl === cleanStartUrl;
          }
        }
        return false;
      });

      if (itemsToDelete.length > 0) {
        sendLog({ type: "progress", message: `🧹 Cleaning ${itemsToDelete.length} previously crawled documents for this source before starting fresh...` });
        dbCurrent.knowledgeBase = dbCurrent.knowledgeBase.filter(
          (doc: any) => !itemsToDelete.some((delItem: any) => delItem.id === doc.id)
        );
        
        // Sync deletion to Firestore
        if (firestoreDb) {
          for (const delDoc of itemsToDelete) {
            try {
              const docRef = doc(firestoreDb, "app_state", "main", "knowledge_base", delDoc.id);
              await deleteDoc(docRef);
            } catch (fbErr) {
              // ignore
            }
          }
        }
        await writeDb(dbCurrent);
      }
    } catch (cleanErr: any) {
      console.error("Failed to clean up old documents before crawling:", cleanErr);
    }

    const queue: { url: string; depth: number }[] = [{ url: startUrlObj.href, depth: 1 }];
    const crawledUrls = new Set<string>();
    let successCount = 0;

    const fetchWithTimeout = async (targetUrl: string, timeoutMs = 6000) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(targetUrl, {
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
            "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache"
          }
        });
        clearTimeout(timer);
        return response;
      } catch (err) {
        clearTimeout(timer);
        throw err;
      }
    };

    while (queue.length > 0 && crawledUrls.size < pagesToCrawl) {
      const current = queue.shift();
      if (!current) continue;

      if (crawledUrls.has(current.url)) {
        continue;
      }

      crawledUrls.add(current.url);
      sendLog({ type: "progress", message: `➡️ Fetching level ${current.depth} URL [${crawledUrls.size}/${pagesToCrawl}]: ${current.url}` });

      try {
        // Politeness delay
        await new Promise((resolve) => setTimeout(resolve, 300));

        const response = await fetchWithTimeout(current.url);
        if (!response.ok) {
          sendLog({ type: "warning", message: `⚠️ HTTP error ${response.status} fetching ${current.url}. Skipping.` });
          continue;
        }

        const contentType = response.headers.get("content-type") || "";
        if (!contentType.toLowerCase().includes("text/html")) {
          sendLog({ type: "warning", message: `⚠️ Skipped non-HTML contentType (${contentType}) at ${current.url}` });
          continue;
        }

        const html = await response.text();
        const { title: cleanPageTitle, content: bodyText, childHrefs } = cleanHtmlContent(html, current.url);

        // Add child URLs to queue if depth limit allows
        if (current.depth < depthToCrawl) {
          let linkCount = 0;
          childHrefs.forEach((href) => {
            try {
              const resolved = new URL(href, current.url);
              // Deep link security and scoping (Strictly same hostname)
              if (resolved.hostname === allowedHostname && (resolved.protocol === "http:" || resolved.protocol === "https:")) {
                resolved.hash = ""; // Strip sections to treat as single URL
                const cleanHref = resolved.href;

                // Subfolder/path scoping: Only crawl URLs sharing the start path prefix to avoid domain-wide crawling
                let isSameSubfolder = false;
                try {
                  const startPathClean = startUrlObj.pathname.toLowerCase().replace(/\/+$/, "");
                  const resolvedPathClean = resolved.pathname.toLowerCase().replace(/\/+$/, "");
                  
                  if (!startPathClean || startPathClean === "/" || startPathClean === "") {
                    isSameSubfolder = true;
                  } else {
                    if (resolvedPathClean.startsWith(startPathClean)) {
                      isSameSubfolder = true;
                    } else {
                      const lastSlashStart = startPathClean.lastIndexOf("/");
                      if (lastSlashStart > 0) {
                        const parentPath = startPathClean.substring(0, lastSlashStart);
                        if (parentPath && parentPath !== "/" && parentPath.length > 5) {
                          isSameSubfolder = resolvedPathClean.startsWith(parentPath);
                        }
                      }
                    }
                  }
                } catch (e) {
                  isSameSubfolder = true; // Fallback
                }

                if (!isSameSubfolder) {
                  return; // Skip links outside current documentation scope or parent branch
                }

                if (!crawledUrls.has(cleanHref) && !queue.some((q) => q.url === cleanHref)) {
                  const pathname = resolved.pathname.toLowerCase();
                  const staticAssets = [".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip", ".tar", ".gz", ".exe", ".dmg", ".mp4", ".css", ".js", ".json", ".xml", ".svg", ".avi"];
                  if (!staticAssets.some((ext) => pathname.endsWith(ext))) {
                    queue.push({ url: cleanHref, depth: current.depth + 1 });
                    linkCount++;
                  }
                }
              }
            } catch (err) {
              // Ignore invalid url structures
            }
          });
          if (linkCount > 0) {
            sendLog({ type: "progress", message: `   Found ${linkCount} new sub-URLs on same host added to queue.` });
          }
        }

        if (bodyText.length < 40) {
          sendLog({ type: "warning", message: `⚠️ Content on ${current.url} seems too short or empty. Skipping storage.` });
          continue;
        }

        const sourceMetadata = `[출처 URL: ${current.url}]\n[크롤링 수준: Depth ${current.depth}]\n\n`;
        const finalContent = sourceMetadata + bodyText;

        // Save into local Database immediately
        const db = readDb();
        if (!db.knowledgeBase) db.knowledgeBase = [];

        // Intelligent automatic tag indexing system for maximum RAG accuracy
        const combinedForTags = `${cleanPageTitle} ${bodyText}`.toLowerCase();
        const autoTags = ["crawled", allowedHostname];
        
        const possibleTechKeywords = [
          { key: "ufm", matches: ["ufm", "unified fabric manager", "ufm-sdn", "nvidia-sm"] },
          { key: "lacp", matches: ["lacp", "bonding", "cl-net", "bond"] },
          { key: "bonding", matches: ["bonding", "bond", "lacp"] },
          { key: "bridge", matches: ["bridge", "vlan bridge", "브릿지", "브리짓"] },
          { key: "vlan", matches: ["vlan", "vlans"] },
          { key: "vxlan", matches: ["vxlan", "vxlans"] },
          { key: "cumulus", matches: ["cumulus", "큐물러스"] },
          { key: "infiniband", matches: ["infiniband", "인피니밴드", "mellanox", "hca"] },
          { key: "opensm", matches: ["opensm", "openSM"] },
          { key: "mstflint", matches: ["mstflint", "펌웨어", "firmware"] },
          { key: "guid", matches: ["guid", "hca", "어댑터"] },
          { key: "ibstat", matches: ["ibstat", "ibnetdiscover"] },
          { key: "nvidia", matches: ["nvidia", "mellanox"] }
        ];

        possibleTechKeywords.forEach(t => {
          if (t.matches.some(m => combinedForTags.includes(m))) {
            if (!autoTags.includes(t.key)) {
              autoTags.push(t.key);
            }
          }
        });

        // Check if document already exists to avoid duplication
        const existingIdx = db.knowledgeBase.findIndex((doc: any) => {
          if (doc.sourceUrl && doc.sourceUrl.toLowerCase().replace(/\/+$/, "") === current.url.toLowerCase().replace(/\/+$/, "")) return true;
          if (cleanSourceTitle(doc.title) === cleanSourceTitle(cleanPageTitle)) return true;
          return false;
        });

        let savedDocId = "";
        if (existingIdx !== -1) {
          savedDocId = db.knowledgeBase[existingIdx].id;
          db.knowledgeBase[existingIdx] = {
            ...db.knowledgeBase[existingIdx],
            title: `[웹사이트] ${cleanPageTitle}`,
            tags: autoTags,
            sourceUrl: current.url,
            content: finalContent,
            updatedAt: new Date().toISOString()
          };
        } else {
          savedDocId = `kb_crawl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
          const docItem = {
            id: savedDocId,
            title: `[웹사이트] ${cleanPageTitle}`,
            category: docCategory,
            tags: autoTags,
            sourceUrl: current.url,
            content: finalContent,
            updatedAt: new Date().toISOString()
          };
          db.knowledgeBase.unshift(docItem);
        }

        await writeDb(db);

        successCount++;
        sendLog({ 
          type: "saved", 
          message: `✅ Saved: "${cleanPageTitle}" (${bodyText.length} characters)`, 
          docId: savedDocId, 
          title: cleanPageTitle, 
          url: current.url
        });

      } catch (crawlErr: any) {
        sendLog({ type: "warning", message: `❌ Error crawling ${current.url}: ${crawlErr.message || "Unknown Network Error"}` });
      }
    }

    try {
      const finalDb = readDb();
      if (!finalDb.sourceUrls) finalDb.sourceUrls = [];

      // Find count of documents that belong to this starting source URL
      const docCount = (finalDb.knowledgeBase || []).filter((doc: any) => {
        if (!doc.id.startsWith("kb_crawl_")) return false;
        if (doc.sourceUrl) {
          return doc.sourceUrl.toLowerCase().replace(/\/+$/, "") === startUrlObj.href.toLowerCase().replace(/\/+$/, "");
        }
        if (doc.content) {
          const match = doc.content.match(/\[출처 URL: ([^\]]+)\]/);
          if (match && match[1]) {
            const cleanDocUrl = match[1].toLowerCase().trim().replace(/\/+$/, "");
            const cleanStartUrl = startUrlObj.href.toLowerCase().trim().replace(/\/+$/, "");
            return cleanDocUrl.startsWith(cleanStartUrl) || cleanDocUrl === cleanStartUrl;
          }
        }
        return false;
      }).length;

      const matchedSrcIdx = finalDb.sourceUrls.findIndex((item: any) => {
        return item.url.toLowerCase().replace(/\/+$/, "") === startUrlObj.href.toLowerCase().replace(/\/+$/, "");
      });

      if (matchedSrcIdx !== -1) {
        finalDb.sourceUrls[matchedSrcIdx].lastCrawledAt = new Date().toISOString();
        finalDb.sourceUrls[matchedSrcIdx].count = docCount;
        finalDb.sourceUrls[matchedSrcIdx].maxPages = pagesToCrawl;
        finalDb.sourceUrls[matchedSrcIdx].maxDepth = depthToCrawl;
        finalDb.sourceUrls[matchedSrcIdx].category = docCategory;
      } else {
        finalDb.sourceUrls.unshift({
          id: `src_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          url: startUrlObj.href,
          maxPages: pagesToCrawl,
          maxDepth: depthToCrawl,
          category: docCategory,
          createdAt: new Date().toISOString(),
          lastCrawledAt: new Date().toISOString(),
          count: docCount
        });
      }
      await writeDb(finalDb);
    } catch (dbErr) {
      console.error("Failed to automatically register source URL:", dbErr);
    }

    sendLog({ type: "complete", message: `🎉 Crawling complete! Successfully harvested ${successCount} documents from ${crawledUrls.size} page attempts.`, count: successCount });
    clearInterval(heartbeat);
    res.end();

  } catch (globalErr: any) {
    sendLog({ type: "error", message: `🚨 Critical crawling failure: ${globalErr.message || "Scrawler halted"}` });
    clearInterval(heartbeat);
    res.end();
  }
});

// Sleep helper
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Background calendar registration worker with up to 3 automatic retries across 2 minutes
async function registerCalendarWithRetryBackground(logId: string) {
  const maxRetries = 3;
  const retryIntervalMs = 40 * 1000; // 40 seconds * 3 retries = 120 seconds (2 minutes)

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 1. Read latest DB state
    const db = readDb();
    const logIndex = db.history.findIndex((item: any) => item.id === logId);
    if (logIndex === -1) {
      console.log(`[Retry Task Log ${logId}] Log entry disappeared from database. Stopping retries.`);
      return;
    }

    const logItem = db.history[logIndex];

    // If it already succeeded, stop retrying
    if (logItem.status === "success") {
      console.log(`[Retry Task Log ${logId}] Succeeded. No further retries.`);
      return;
    }

    // If it is in pending_calendar status but has no valid token, wait for the user to relink
    if (logItem.status === "pending_calendar") {
      console.log(`[Retry Task Log ${logId}] OAuth connection is broken/expired. Stopping auto-retries until user authenticates.`);
      return;
    }

    // Set interactive "retrying" status so it renders elegantly in the UI
    if (attempt > 0) {
      logItem.status = "retrying";
      logItem.errorMessage = `일시적인 구글 연동 장애로 자동 예약 재시도 중입니다... (재시도 중: ${attempt}/3회차, 약 40초 간격)`;
      db.history[logIndex] = logItem;
      writeDb(db);
    }

    try {
      const token = await getValidAccessToken();
      const calendarId = db.settings?.targetCalendarId || "primary";

      if (!token) {
        throw new Error("Google access token missing/invalid");
      }

      console.log(`[Retry Task Log ${logId}] Attempt ${attempt + 1}/${maxRetries + 1} starting...`);
      const googleEventResult = await createGoogleCalendarEvent(token, calendarId, logItem.aiSummary);

      // success!
      const finalDb = readDb();
      const finalIdx = finalDb.history.findIndex((item: any) => item.id === logId);
      if (finalIdx !== -1) {
        finalDb.history[finalIdx].calendarEventId = googleEventResult.id || "";
        finalDb.history[finalIdx].calendarEventLink = googleEventResult.htmlLink || "";
        finalDb.history[finalIdx].status = "success";
        finalDb.history[finalIdx].errorMessage = "";
        writeDb(finalDb);
      }
      console.log(`[Retry Task Log ${logId}] Succeeded on attempt ${attempt + 1}!`);
      return;
    } catch (err: any) {
      console.error(`[Retry Task Log ${logId}] Attempt ${attempt + 1} failed:`, err.message);

      const errLower = err.message.toLowerCase();
      const isAuthError = errLower.includes("401") || 
                          errLower.includes("unauthorized") || 
                          errLower.includes("auth") || 
                          errLower.includes("credential") || 
                          errLower.includes("token");

      const errorDb = readDb();
      const errorIdx = errorDb.history.findIndex((item: any) => item.id === logId);
      if (errorIdx !== -1) {
        if (isAuthError) {
          // Break cycle and clear credentials if it's an authentication block
          errorDb.history[errorIdx].status = "pending_calendar";
          errorDb.history[errorIdx].errorMessage = "구글 캘린더 연동 세션이 만료되었습니다. 상단의 'Sign in with Google'을 다시 연동해 주세요.";
          if (errorDb.credentials) {
            errorDb.credentials.accessToken = "";
            errorDb.credentials.tokenExpiry = 0;
          }
          writeDb(errorDb);
          return;
        }

        // On last attempt, transition to failed_calendar
        if (attempt === maxRetries) {
          errorDb.history[errorIdx].status = "failed_calendar";
          errorDb.history[errorIdx].errorMessage = `구글 일정 등록이 일시적 장애(네트워크 등)로 인해 3회 자동 재시도했으나 최종 실패했습니다. (최종 오류: ${err.message})`;
          writeDb(errorDb);
        } else {
          // Keep current failure description for the UI to show
          errorDb.history[errorIdx].errorMessage = `일정 등록 시도 실패: ${err.message}. 잠시 후 자동 재시도합니다... (대기 중)`;
          writeDb(errorDb);
        }
      }

      // If we still have more retry attempts left, sleep before starting the next turn
      if (attempt < maxRetries) {
        await sleep(retryIntervalMs);
      }
    }
  }
}

// Retry / Resend single event to Google Calendar
app.post("/api/history/retry", async (req, res) => {
  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ error: "Log ID is required." });
  }

  const db = readDb();
  const historyEntry = db.history.find((item: any) => item.id === id);

  if (!historyEntry) {
    return res.status(404).json({ error: "해당 로그 항목을 찾을 수 없습니다." });
  }

  const token = await getValidAccessToken();
  if (!token) {
    return res.status(401).json({ error: "현재 Google 캘린더 연동이 되어있지 않거나 만료되었습니다. 상단에서 'Sign in with Google'을 완료하신 후 재전송해 주세요." });
  }

  // Update status to processing
  historyEntry.status = "processing";
  historyEntry.errorMessage = "구글 일정 자동 등록 시도 중...";
  writeDb(db);

  try {
    let aiResult = historyEntry.aiSummary;

    // 1. If AI summary is not yet captured (completely failed run earlier), re-extract with Gemini
    if (!aiResult) {
      console.log(`[Retry] AI Summary missing for Log ${id}. Re-running Gemini parsing...`);
      aiResult = await processEmailWithAI(historyEntry.subject, historyEntry.body, historyEntry.dateReceived);
      historyEntry.isReply = checkIfReply(historyEntry.subject, historyEntry.body);
      historyEntry.hasEvent = aiResult.has_event;
      historyEntry.aiSummary = aiResult;
    if (aiResult) aiResult.attachmentNames = attachmentNames;
    } else if (historyEntry.isReply === undefined) {
      historyEntry.isReply = checkIfReply(historyEntry.subject, historyEntry.body);
    }

    // Save state back to DB before beginning background worker
    const dbSave = readDb();
    const index = dbSave.history.findIndex((item: any) => item.id === id);
    if (index !== -1) {
      dbSave.history[index] = historyEntry;
    }
    writeDb(dbSave);

    // 2. Start background worker with 3 automatic retries
    registerCalendarWithRetryBackground(id);

    return res.json({ success: true, log: historyEntry });
  } catch (err: any) {
    console.error("[Retry Error in AI Step]", err);
    historyEntry.errorMessage = err.message || "Unknown error parsing AI content.";
    historyEntry.status = "failed";

    const dbSave = readDb();
    const index = dbSave.history.findIndex((item: any) => item.id === id);
    if (index !== -1) {
      dbSave.history[index] = historyEntry;
    }
    writeDb(dbSave);

    return res.status(500).json({ error: err.message });
  }
});

// Core Workflow Executor (Shared between Webhook & Manual Test)
async function executeWorkflow(subject: string, body: string, dateReceived: string, attachmentNames: string[] = []) {
  const emailSubject = subject || "(No Subject)";
  const emailBody = body || "(No Body)";
  const receivedDate = dateReceived || new Date().toISOString();
  
  const isReply = checkIfReply(emailSubject, emailBody);

  const historyEntry: any = {
    id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    timestamp: new Date().toISOString(),
    subject: emailSubject,
    body: emailBody.substring(0, 500) + (emailBody.length > 500 ? "..." : ""),
    dateReceived: receivedDate,
    hasEvent: false,
    isReply: isReply,
    aiSummary: null,
    calendarEventId: "",
    calendarEventLink: "",
    status: "processing",
    errorMessage: "",
  };

  // 1. Process with Gemini
  let aiResult;
  try {
    aiResult = await processEmailWithAI(emailSubject, emailBody, receivedDate);
    // Overwrite with processed reply status if Gemini context or formatting updated it
    historyEntry.isReply = isReply;
    historyEntry.hasEvent = aiResult.has_event;
    historyEntry.aiSummary = aiResult;
  } catch (error: any) {
    console.error("AI processing error:", error);
    historyEntry.status = "failed";
    
    const errStr = (error.message || "").toLowerCase();
    const isQuotaError = errStr.includes("429") || errStr.includes("quota") || errStr.includes("rate") || errStr.includes("exhausted");
    
    if (isQuotaError) {
      historyEntry.errorMessage = "인공지능(Gemini AI) 분석 호출 한도(Quota Exceeded/Rate Limit)가 초과되었습니다. 사용 중이신 API 키의 호출 속도 한도 초과 상태입니다. 잠시 후 테스터나 메일 발송을 다시 시도해 주세요. 유료결제 요금제 키를 적용하신 경우에도 결제 연동 시점의 계정 동기화 혹은 API 일시적 정체로 해당 오류가 발생할 수 있으므로, 약 1~2분 후 다시 요청해 주시기 바랍니다.";
    } else {
      historyEntry.errorMessage = `Gemini AI 분석 실패: ${error.message}`;
    }
    
    // Save failed entry
    const db = readDb();
    db.history.unshift(historyEntry);
    writeDb(db);
    return historyEntry;
  }

  // 2. Schedule Event on Google Calendar (both for specific schedule events and email summary events at receive time)
  const db = readDb();
  const token = await getValidAccessToken();

  if (!token) {
    historyEntry.status = "pending_calendar";
    historyEntry.errorMessage = "Google 캘린더 연동이 비인증/만료 상태입니다. 캘린더 자동 등록을 위해 상단에서 Google 계정을 연동해 주세요.";
    
    // Write back to DB logs
    const dbSave = readDb();
    dbSave.history.unshift(historyEntry);
    writeDb(dbSave);
  } else {
    // Write to DB with 'processing' state first
    historyEntry.status = "processing";
    historyEntry.errorMessage = historyEntry.hasEvent
      ? "감지된 메일 일정을 구글 캘린더에 등록 중..."
      : "수신 시점 기준 메일 요약을 구글 캘린더에 등록 중...";
    
    const dbSave = readDb();
    dbSave.history.unshift(historyEntry);
    writeDb(dbSave);

    // Run calendar registration with automatic up to 3 retries over 2 minutes in background
    registerCalendarWithRetryBackground(historyEntry.id);
  }

  return historyEntry;
}

// Gmail Sync Trigger - Directly pulls recent emails from connected Gmail account
app.post("/api/gmail/sync", async (req, res) => {
  try {
    const token = await getValidAccessToken();
    if (!token) {
      return res.status(401).json({ error: "Gmail / 구글 캘린더 연동이 완료되지 않았습니다. 상단에서 'Sign in with Google'로 인증해 주세요." });
    }

    const maxResults = req.body?.maxResults || 5;
    const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}&q=label:INBOX`;
    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!listRes.ok) {
      const errTxt = await listRes.text();
      return res.status(listRes.status).json({ error: `Gmail API 접근 오류: ${errTxt}` });
    }

    const listData = await listRes.json();
    const messages = listData.messages || [];

    if (messages.length === 0) {
      return res.json({ success: true, processedCount: 0, message: "동기화할 수신 메일이 없습니다." });
    }

    const processedLogs: any[] = [];
    
    for (const msg of messages) {
      const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`;
      const msgRes = await fetch(msgUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!msgRes.ok) continue;

      const msgData = await msgRes.json();
      const headers = msgData.payload?.headers || [];

      const subjectHeader = headers.find((h: any) => h.name.toLowerCase() === "subject");
      const dateHeader = headers.find((h: any) => h.name.toLowerCase() === "date");

      const subject = subjectHeader ? subjectHeader.value : "(제목 없음)";
      const dateReceived = dateHeader ? new Date(dateHeader.value).toISOString() : new Date().toISOString();

      let bodyText = msgData.snippet || "";
      if (msgData.payload?.parts) {
        const textPart = msgData.payload.parts.find((p: any) => p.mimeType === "text/plain");
        if (textPart && textPart.body && textPart.body.data) {
          bodyText = Buffer.from(textPart.body.data, "base64").toString("utf-8");
        }
      }

      // Check duplicate
      const currentDb = readDb();
      const existing = (currentDb.history || []).find((h: any) => h.subject === subject && Math.abs(new Date(h.dateReceived).getTime() - new Date(dateReceived).getTime()) < 60000);
      if (existing) continue;

      const logResult = await executeWorkflow(subject, bodyText, dateReceived);
      processedLogs.push(logResult);
    }

    res.json({
      success: true,
      processedCount: processedLogs.length,
      logs: processedLogs,
      message: `${processedLogs.length}개의 최신 수신 메일을 조회하여 일정 감지 및 구글 캘린더 등록 처리를 완료했습니다.`
    });
  } catch (error: any) {
    console.error("Gmail sync error:", error);
    res.status(500).json({ error: error.message || "Gmail 동기화 중 오류가 발생했습니다." });
  }
});

// Manual Test Trigger
app.post("/api/test-trigger", async (req, res) => {
  const { subject, body, date_received } = req.body;
  try {
    const hasAttachment = req.body.has_attachment === true || req.body.has_attachment === "true" || (req.body.attachment_count && parseInt(req.body.attachment_count, 10) > 0) || !!req.body.attachment || !!req.body.attachments;
    const attachmentNames = hasAttachment ? ["첨부파일 있음 (테스트)"] : [];
    const result = await executeWorkflow(subject, body, date_received, attachmentNames);
    res.json({ success: true, log: result });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Zapier Incoming Webhook Endpoint & Root URL Webhook Fallback (Supports users who copy-pasted only the domain)
// Expects: { "subject": "...", "body": "...", "date_received": "..." }
const handleIncomingWebhook = async (req: any, res: any) => {
  // Graceful fuzzy key mapping to allow Zapier flexibility
  const subject = req.body.subject || req.body.title || req.body.email_subject || "(No Subject)";
  const body = req.body.body || req.body.content || req.body.text || req.body.email_body || "(No Body)";
  const date_received = req.body.date_received || req.body.date || req.body.received_at || new Date().toISOString();

  console.log("----------------------------------------");
  console.log(`Zapier Webhook Received (${req.path})!`);
  console.log("Subject:", subject);
  console.log("Timestamp:", date_received);
  console.log("----------------------------------------");

  let attachmentNames: string[] = [];
  if (req.body.attachment_names && Array.isArray(req.body.attachment_names)) {
    attachmentNames = [...req.body.attachment_names];
  } else if (typeof req.body.attachment_names === "string") {
    attachmentNames = req.body.attachment_names.split(",").map((s: string) => s.trim());
  } else if (req.body.attachment_name) {
    attachmentNames.push(req.body.attachment_name);
  }
  
  if (Array.isArray(req.body.attachments)) {
    req.body.attachments.forEach((a: any) => {
      if (a && typeof a === "object") {
        if (a.filename) attachmentNames.push(a.filename);
        else if (a.name) attachmentNames.push(a.name);
      } else if (typeof a === "string") {
        attachmentNames.push(a);
      }
    });
  } else if (req.body.attachments && typeof req.body.attachments === "string") {
    attachmentNames.push(req.body.attachments);
  }
  
  if (req.body.file_name) attachmentNames.push(req.body.file_name);
  if (Array.isArray(req.body["Attachment Details"])) {
      req.body["Attachment Details"].forEach((a: any) => {
         if (a.filename) attachmentNames.push(a.filename);
         else if (a.name) attachmentNames.push(a.name);
         else if (typeof a === "string") attachmentNames.push(a);
      });
  } else if (typeof req.body["Attachment Details"] === "string") {
      try {
         const parsed = JSON.parse(req.body["Attachment Details"]);
         if (Array.isArray(parsed)) {
             parsed.forEach((a: any) => {
                 if (a.filename) attachmentNames.push(a.filename);
                 else if (a.name) attachmentNames.push(a.name);
             });
         }
      } catch (e) {
         if (req.body["Attachment Details"].includes("exists")) {
             // likely just a flag, ignore
         } else {
             attachmentNames.push(...req.body["Attachment Details"].split(",").map((s: string) => s.trim()));
         }
      }
  }
  
  attachmentNames = Array.from(new Set(attachmentNames.filter(Boolean)));
  
  const hasAttachment = req.body.has_attachment === true || req.body.has_attachment === "true" || (req.body.attachment_count && parseInt(req.body.attachment_count, 10) > 0) || !!req.body.attachment || !!req.body.attachments;
  
  if (attachmentNames.length === 0 && hasAttachment) {
      attachmentNames.push("첨부파일 있음 (이름 알 수 없음)");
  }

  try {
    const result = await executeWorkflow(subject, body, date_received, attachmentNames);
    res.json({
      success: true,
      message: "Webhook processed successfully",
      classification: result.hasEvent ? "scheduled_event" : "email_summary",
      logId: result.id,
      schedulingStatus: result.status,
    });
  } catch (error: any) {
    console.error("Webhook processing error:", error);
    res.status(500).json({ error: error.message });
  }
};

app.post("/api/webhook", handleIncomingWebhook);
app.post("/", handleIncomingWebhook);

// Catch-all 404 for any unmatched /api routes to prevent HTML SPA fallback
app.all("/api/*", (req, res) => {
  res.status(404).json({ error: "API endpoint not found", path: req.path });
});

// Express error handler middleware for API requests
app.use((err: any, req: any, res: any, next: any) => {
  if (req.path && req.path.startsWith("/api")) {
    return res.status(500).json({ error: err?.message || "Internal Server Error" });
  }
  next(err);
});

// Start server
async function startServer() {
  // Sync memory cache from warm permanent cloud Firestore in the background 
  // to avoid any block/timeout during cold starts or network handshakes. 
  // The server remains immediately available with its local file fallback.
  initDbAndSyncFirestore().catch(err => {
    console.warn("[Firebase] Error in background Firestore sync launch:", err);
  });

  // Start background token refresher macro
  startBackgroundTokenRefresher();

  // Start background automatic RAG source crawler sync scheduler
  startBackgroundAutoRecrawlScheduler();

  // Vite Integration for development / static server for build
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });
}

startServer();
