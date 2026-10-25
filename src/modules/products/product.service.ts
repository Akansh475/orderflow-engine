import { productRepository } from "./product.repository.js";
import {
  createProductSchema,
  productQuerySchema,
} from "./product.validation.js";
import { createPaginationMeta } from "../../shared/types.js";
import { productCache } from "./product.cache.js";

export const productService = {
  async getAllProducts(query: unknown = {}) {
    const params = productQuerySchema.parse(query);
    const cacheKey = productCache.getProductListKey(params);
    const cachedResult = await productCache.get(cacheKey);

    if (cachedResult) {
      return cachedResult;
    }

    const { products, total } =
      await productRepository.findPaginatedWithCount(params);

    const result = {
      data: products,
      pagination: createPaginationMeta(params.page, params.limit, total),
    };

    await productCache.set(cacheKey, result);

    return result;
  },

  async getProductById(id: string) {
    const cacheKey = productCache.getProductDetailKey(id);
    const cachedProduct = await productCache.get(cacheKey);

    if (cachedProduct) {
      return cachedProduct;
    }

    const product = await productRepository.findById(id);

    if (!product) {
      throw new Error("Product not found");
    }

    await productCache.set(cacheKey, product);

    return product;
  },

  async createProduct(input: unknown) {
    const data = createProductSchema.parse(input);

    const product = await productRepository.create(data);

    await productCache.invalidateProductLists();

    return product;
  },
};
