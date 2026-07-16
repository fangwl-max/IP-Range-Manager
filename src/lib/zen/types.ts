export type NetworkType = "PremiumBGP" | "StandardBGP";

export type ZenJob = {
  cidrBlock: string;
  networkType: NetworkType;
  regionId: string;
  asn: number;
  cityName?: string;
  bandwidthClusterName?: string;
  bandwidthClusterId?: string;
};

export type PipelineRequest = {
  jobs: ZenJob[];
  /** ?? CreateByoip?CIDR ???? */
  skipByoip: boolean;
  /** ????????EIP?? CreateByoip */
  dryRun: boolean;
};

export type ProgressEvent =
  | { type: "job_start"; index: number; total: number; cidr: string }
  | { type: "step"; step: string; title: string; detail?: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "cidr_poll"; attempt: number; max: number; status?: string }
  | { type: "cidr_ready"; cidrId: string; totalCount?: number; usedCount?: number }
  | {
      type: "eip_batch";
      batchIndex: number;
      batchTotal: number;
      firstName: string;
      lastName: string;
      count: number;
    }
  | { type: "eip_attempt"; current: number; total: number; ip: string; name: string }
  | { type: "eip_progress"; current: number; total: number; ip: string; name: string }
  | { type: "job_done"; index: number; cidr: string }
  | { type: "pipeline_done" }
  | { type: "error"; message: string };

export type EipDeleteTask = {
  /** ????????scanRegionIds ????????????*/
  regionId: string;
  cidrBlock: string;
};

export type EipDeleteRequest = {
  tasks: EipDeleteTask[];
  /** ?? regionId ????????? DescribeByoipRegions ???? */
  scanRegionIds: string[];
  dryRun: boolean;
  /**
   * ??true ??????????EIP ?? UnassociateEipAddress?? DeleteEip??   * ?? EIP???????????????????????   */
  unbindBeforeDelete?: boolean;
};

/** ??????/api/eip-delete NDJSON ?? */
export type EipDeleteEvent =
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | {
      type: "segment_phase";
      segmentIndex: number;
      segmentTotal: number;
      cidr: string;
      phase: "listing" | "unbinding" | "deleting";
    }
  | {
      type: "segment_scan_progress";
      segmentIndex: number;
      segmentTotal: number;
      cidr: string;
      round: 1 | 2;
      regionId: string;
      /** ??????1..regionTotal??????1 */
      regionOrdinal: number;
      regionTotal: number;
      page: number;
      maxPages: number;
      matched: number;
      cap: number | null;
      /** ???????????????????????? null???? matched */
      mergedTotal: number | null;
    }
  | {
      type: "delete_progress";
      current: number;
      total: number;
      eipId: string;
      ip: string;
      segmentIndex: number;
      segmentTotal: number;
      cidr: string;
    }
  | {
      type: "delete_done";
      deleted: number;
      skippedBound: number;
      failed: number;
      dryRun: boolean;
      /** ???????????? DeleteEip ????*/
      deletableCount: number;
      cidr: string;
      segmentIndex: number;
      segmentTotal: number;
    }
  | { type: "error"; message: string };

/** ? BYOIP ???CreateByoip???? EIP? */
export type ByoipAnnounceRequest = {
  jobs: ZenJob[];
  dryRun: boolean;
};

export type ByoipAnnounceEvent =
  | { type: "job_start"; index: number; total: number; cidr: string }
  | { type: "step"; step: string; title: string; detail?: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "cidr_poll"; attempt: number; max: number; status?: string }
  | { type: "cidr_ready"; cidrId: string; totalCount?: number; usedCount?: number }
  | { type: "job_done"; index: number; cidr: string }
  | { type: "pipeline_done" }
  | { type: "error"; message: string };

/** ?? BYOIP ???DeleteCidr? */
export type ByoipWithdrawTask = {
  regionId: string;
  cidrBlock: string;
};

export type ByoipWithdrawRequest = {
  tasks: ByoipWithdrawTask[];
  /** ?? regionId ????????? */
  scanRegionIds: string[];
  dryRun: boolean;
};


/** BMC VOB 宣告：单个 zone-VLAN 对 */
export type BmcByoipZoneEntry = {
  zoneId: string;
  publicVirtualInterfaceId: string;
};

/**
 * BMC VOB 宣告 job（CreateByoip via /api/v2/bmc）
 * zones 为多个可用区，每个可用区对应一个 publicVirtualInterfaceId
 */
export type BmcByoipJob = {
  cidrBlock: string;
  asn: number;
  zones: BmcByoipZoneEntry[];
  ipType?: "IPV4";
};

/** BMC VOB 宣告请求 */
export type BmcByoipAnnounceRequest = {
  jobs: BmcByoipJob[];
  dryRun: boolean;
};
export type ByoipWithdrawEvent =
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | {
      type: "segment_phase";
      segmentIndex: number;
      segmentTotal: number;
      cidr: string;
      phase: "lookup" | "deleting" | "done" | "error" | "skipped";
    }
  | {
      type: "segment_done";
      segmentIndex: number;
      segmentTotal: number;
      cidr: string;
      cidrId?: string;
      regionId?: string;
      dryRun: boolean;
      deleted: boolean;
      message?: string;
    }
  | {
      type: "segment_skipped";
      segmentIndex: number;
      segmentTotal: number;
      cidr: string;
      cidrId: string;
      regionId: string;
      usedCount: number;
      message: string;
    }
  | { type: "error"; message: string };
