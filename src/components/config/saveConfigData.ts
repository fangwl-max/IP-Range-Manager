import { message } from 'antd';
import { projectGroupStorage, supplierStorage, usageAreaStorage, asnStorage, asnGroupStorage, ipSegmentStorage } from '../../utils/storage';

export async function saveConfigDataToFile(): Promise<void> {
  try {
    const allData = {
      ipSegments: ipSegmentStorage.getAll(),
      projectGroups: projectGroupStorage.getAll(),
      suppliers: supplierStorage.getAll(),
      usageAreas: usageAreaStorage.getAll(),
      asns: asnStorage.getAll(),
      asnGroups: asnGroupStorage.getAll(),
      exportTime: new Date().toISOString(),
      version: '1.0.0',
    };

    const response = await fetch('/api/save-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(allData, null, 2),
    });

    if (response.ok) {
      message.success('数据已成功保存到本地文件 (ip-data.json)');
    } else {
      throw new Error('Server responded with error');
    }
  } catch (error) {
    console.error('保存失败:', error);
    message.error('数据保存失败');
  }
}
