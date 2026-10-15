// Mode: Run Once for Each Item
// Input: the ERPNext style template ({ data: {...} }). Builds the Shopify lookup (by the
// first size's SKU) and the multi-variant productSet request.
// @include lib/product-model.js
// @include lib/shopify.js

// The ERP item can arrive wrapped in "data" or on its own; handle both.
const item = $json.data || $json;
// Build the Shopify "create product" request. Pull "firstSku" out separately and keep
// everything else in productSetBody.
const { firstSku, ...productSetBody } = buildProductSetRequest(item);
// Send one item on to the next node.
return { json: {
  // The ERP item code (the style template's SKU base).
  sku: item.name,
  // The human-readable product name.
  itemName: item.item_name,
  // How many sizes (variants) the product will have.
  variantCount: productSetBody.variables.input.variants.length,
  // A Shopify query that checks "does a variant with this SKU already exist?"
  // so we never create the same product twice.
  findVariantBody: {
    query: 'query findVariant($q: String!) { productVariants(first: 1, query: $q) { nodes { id sku product { id status } } } }',
    // JSON.stringify wraps the SKU in quotes so Shopify searches for it exactly.
    variables: { q: `sku:${JSON.stringify(firstSku)}` },
  },
  // The full "create product" request, used only if the lookup finds nothing.
  productSetBody,
} };
