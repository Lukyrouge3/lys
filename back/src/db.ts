import { PrismaPg } from "@prisma/adapter-pg";
import { MessageRole, PrismaClient } from "@/generated/prisma/client.ts";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: Deno.env.get("DATABASE_URL") }),
}).$extends({
  result: {
    message: {
      modelMessage: {
        needs: { role: true, content: true, createdAt: true },
        compute(msg): { role: MessageRole; content: string } {
          const { role, content, createdAt } = msg;
          if (role === "user") {
            return {
              role: "user",
              content: `[${createdAt.toLocaleString()}] ${content}`,
            };
          }
          return {
            role: role,
            content: content,
          };
        },
      },
    },
  },
});

export default prisma;
