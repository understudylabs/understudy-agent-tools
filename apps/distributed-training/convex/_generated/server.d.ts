import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";

type PublicDataModel = any;

export type QueryCtx = GenericQueryCtx<PublicDataModel>;
export type MutationCtx = GenericMutationCtx<PublicDataModel>;

export declare const query: any;
export declare const mutation: any;
