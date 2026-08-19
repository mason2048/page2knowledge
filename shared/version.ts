export const PRODUCT_NAME = 'page2knowledge' as const;
export const PRODUCT_VERSION = '0.2.1' as const;

export const SINGLE_PAGE_USER_AGENT = `Page2Knowledge/${PRODUCT_VERSION} (+local single-page knowledge exporter)`;

export function crawlerUserAgent(productToken: string): string {
  return `${productToken}/${PRODUCT_VERSION} (+local finite crawler)`;
}
