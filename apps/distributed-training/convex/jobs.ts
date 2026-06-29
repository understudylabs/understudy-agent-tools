import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const now = () => Date.now();

export const list = query({
  args: {},
  handler: async (ctx: any) => {
    const jobs = await ctx.db.query("jobs").collect();
    return Promise.all(
      jobs
        .filter((job: any) => job.status !== "removed")
        .sort((a: any, b: any) => b.updatedAt - a.updatedAt)
        .map(async (job: any) => {
          const claims = await ctx.db.query("claims").withIndex("by_job", (q: any) => q.eq("jobId", job._id)).collect();
          const submissions = await ctx.db.query("submissions").withIndex("by_job", (q: any) => q.eq("jobId", job._id)).collect();
          return {
            ...job,
            claims,
            submissions,
          };
        }),
    );
  },
});

export const create = mutation({
  args: {
    title: v.string(),
    slug: v.string(),
    kind: v.union(v.literal("inference"), v.literal("rollout"), v.literal("logprob"), v.literal("eval")),
    priority: v.union(v.literal("low"), v.literal("normal"), v.literal("high")),
    createdBy: v.string(),
    targetRollouts: v.number(),
    rewardUsd: v.optional(v.number()),
    lineageParentId: v.optional(v.id("jobs")),
    model: v.string(),
    weights: v.optional(v.string()),
    promptSet: v.array(v.string()),
    jobSpec: v.string(),
  },
  handler: async (ctx: any, args: any) => {
    const existing = await ctx.db.query("jobs").withIndex("by_slug", (q: any) => q.eq("slug", args.slug)).first();
    if (existing) throw new Error("A job with this slug already exists.");
    const timestamp = now();
    return ctx.db.insert("jobs", {
      ...args,
      status: "open",
      createdAt: timestamp,
      updatedAt: timestamp,
      completedRollouts: 0,
      activeClaims: 0,
      schemaVersion: "understudy.distributed_rollout_job.v1",
    });
  },
});

export const claim = mutation({
  args: {
    jobId: v.id("jobs"),
    workerName: v.string(),
    workerContact: v.optional(v.string()),
    targetRollouts: v.number(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx: any, args: any) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status === "removed" || job.status === "complete") throw new Error("Job is not claimable.");
    const timestamp = now();
    const claimId = await ctx.db.insert("claims", {
      jobId: args.jobId,
      workerName: args.workerName,
      workerContact: args.workerContact,
      status: "active",
      claimedAt: timestamp,
      updatedAt: timestamp,
      targetRollouts: args.targetRollouts,
      submittedRollouts: 0,
      notes: args.notes,
    });
    await ctx.db.patch(args.jobId, {
      status: "running",
      activeClaims: job.activeClaims + 1,
      updatedAt: timestamp,
    });
    return claimId;
  },
});

export const releaseClaim = mutation({
  args: { claimId: v.id("claims") },
  handler: async (ctx: any, args: any) => {
    const claim = await ctx.db.get(args.claimId);
    if (!claim || claim.status !== "active") return null;
    const job = await ctx.db.get(claim.jobId);
    const timestamp = now();
    await ctx.db.patch(args.claimId, { status: "released", updatedAt: timestamp });
    if (job) {
      const nextActive = Math.max(0, job.activeClaims - 1);
      await ctx.db.patch(job._id, {
        activeClaims: nextActive,
        status: job.completedRollouts >= job.targetRollouts ? "complete" : nextActive > 0 ? "running" : "open",
        updatedAt: timestamp,
      });
    }
    return args.claimId;
  },
});

export const submit = mutation({
  args: {
    jobId: v.id("jobs"),
    claimId: v.optional(v.id("claims")),
    workerName: v.string(),
    rolloutCount: v.number(),
    artifactUri: v.optional(v.string()),
    artifactText: v.optional(v.string()),
    baseTrajectoryUri: v.optional(v.string()),
    logprobsUri: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx: any, args: any) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status === "removed") throw new Error("Job is not accepting submissions.");
    const timestamp = now();
    const submissionId = await ctx.db.insert("submissions", { ...args, createdAt: timestamp });
    const completedRollouts = job.completedRollouts + args.rolloutCount;
    await ctx.db.patch(args.jobId, {
      completedRollouts,
      status: completedRollouts >= job.targetRollouts ? "complete" : job.activeClaims > 0 ? "running" : "open",
      updatedAt: timestamp,
    });
    if (args.claimId) {
      const claim = await ctx.db.get(args.claimId);
      if (claim) {
        await ctx.db.patch(args.claimId, {
          submittedRollouts: claim.submittedRollouts + args.rolloutCount,
          status: claim.submittedRollouts + args.rolloutCount >= claim.targetRollouts ? "submitted" : claim.status,
          updatedAt: timestamp,
        });
      }
    }
    return submissionId;
  },
});

export const remove = mutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx: any, args: any) => {
    const timestamp = now();
    await ctx.db.patch(args.jobId, {
      status: "removed",
      removedAt: timestamp,
      updatedAt: timestamp,
    });
    return args.jobId;
  },
});
