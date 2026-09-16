import { useState, useEffect, useCallback } from 'react';

const URL_CHANGE_EVENT = 'urlchange';

/**
 * 将 tab 状态与 URL 路径段双向绑定。
 * segmentIndex: URL 拆分后的位置（菜单 key 在 0，第一级 tab 在 1，以此类推）
 */
export function useUrlTab(
  segmentIndex: number,
  validTabs: readonly string[],
  defaultTab: string,
): [string, (tab: string) => void] {
  const getFromUrl = (): string => {
    const segs = window.location.pathname.replace(/^\/|\/$/g, '').split('/');
    const seg = segs[segmentIndex];
    return seg && (validTabs as string[]).includes(seg) ? seg : defaultTab;
  };

  const [tab, setTabState] = useState<string>(getFromUrl);

  const setTab = useCallback(
    (newTab: string) => {
      setTabState(newTab);
      const segs = window.location.pathname.replace(/^\/|\/$/g, '').split('/');
      while (segs.length <= segmentIndex) segs.push('');
      segs[segmentIndex] = newTab;
      const newPath = '/' + segs.slice(0, segmentIndex + 1).join('/') + '/';
      if (window.location.pathname !== newPath) {
        history.pushState(null, '', newPath);
        window.dispatchEvent(new Event(URL_CHANGE_EVENT));
      }
    },
    [segmentIndex],
  );

  useEffect(() => {
    const handle = () => setTabState(getFromUrl());
    window.addEventListener('popstate', handle);
    window.addEventListener(URL_CHANGE_EVENT, handle);
    return () => {
      window.removeEventListener('popstate', handle);
      window.removeEventListener(URL_CHANGE_EVENT, handle);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentIndex, defaultTab]);

  return [tab, setTab];
}
