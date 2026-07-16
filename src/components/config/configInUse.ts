import { asnStorage, ipSegmentStorage } from '../../utils/storage';

export function checkProjectGroupInUse(groupName: string): boolean {
  const ipSegments = ipSegmentStorage.getAll();
  return ipSegments.some((seg) => seg.projectGroups && seg.projectGroups.includes(groupName));
}

export function checkSupplierInUse(supplierName: string): boolean {
  const ipSegments = ipSegmentStorage.getAll();
  return ipSegments.some((seg) => seg.supplier === supplierName);
}

export function checkUsageAreaInUse(areaName: string): boolean {
  const ipSegments = ipSegmentStorage.getAll();
  return ipSegments.some((seg) => seg.usageArea === areaName);
}

export function checkASNInUse(asnName: string): boolean {
  const ipSegments = ipSegmentStorage.getAll();
  return ipSegments.some((seg) => seg.asn === asnName);
}

export function getAsnCountInGroup(groupId: string): number {
  return asnStorage.getAll().filter((a) => a.asnGroupId === groupId).length;
}
