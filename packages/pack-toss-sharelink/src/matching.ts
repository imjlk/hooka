import type { Subject } from "./contracts";
import type { Category, Product } from "./provider";

const normalize = (text: string): string =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");

/** Include the selected category and its complete descendant subtree. */
function descendants(categories: Category[], id: string): Set<string> {
  const result = new Set<string>();
  const visit = (nodes: Category[], selected: boolean) => {
    for (const node of nodes) {
      const include = selected || node.id === id;
      if (include) result.add(node.id);
      visit(node.children, include);
    }
  };
  visit(categories, false);
  return result;
}

/** Category AND a reviewed keyword must match. Exclusions always win. */
export function matchProducts(
  products: Product[],
  categories: Category[],
  rule: Subject,
): Product[] {
  return eligibleProducts(products, categories, rule).slice(0, 3);
}

/** Only already-fetched page products; the caller still owns the three-attempt limit. */
export function eligibleProducts(
  products: Product[],
  categories: Category[],
  rule: Subject,
): Product[] {
  const allowed = descendants(categories, rule.categoryId);
  const excluded = new Set(
    rule.excludedCategoryIds.flatMap((id) => [
      ...descendants(categories, id),
      id,
    ]),
  );
  const seen = new Set<string>();
  return products.filter((product) => {
    const title = normalize(product.title);
    if (
      seen.has(product.id) ||
      (rule.pinnedProductId !== undefined &&
        product.id !== rule.pinnedProductId) ||
      product.soldOut ||
      (product.endAt ?? Infinity) <= Date.now() + 60000 ||
      rule.excludedProductIds.includes(product.id) ||
      !product.categoryIds.some((id) => allowed.has(id)) ||
      product.categoryIds.some((id) => excluded.has(id)) ||
      !rule.keywords.some((word) => title.includes(normalize(word))) ||
      rule.excludedKeywords.some((word) => title.includes(normalize(word)))
    )
      return false;
    seen.add(product.id);
    return true;
  });
}
