import { defineRule } from "@oxlint/plugins";

const lintDirective = /^\s*(?:oxlint|eslint)-(?:disable|enable)(?:-next-line|-line)?(?:\s|$)/u;

export const noCommentsRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Ban source comments; only lint directives are allowed.",
    },
    messages: {
      comment:
        "Comments are not allowed. Encode the intent in names, types or tests; only lint directives may stay.",
    },
  },
  createOnce(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (lintDirective.test(comment.value)) continue;
          context.report({ loc: comment.loc, messageId: "comment" });
        }
      },
    };
  },
});
