export function formatShortSourceTitle(title: string): string {
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

  title = title.replace(/v?\d+\.\d+(?:\.\d+)*(?:\s*LTS)?(?:layout-\d+)*/gi, "").trim();

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
