import * as z from 'zod';

/**
 * Each agent config represents an individual agent
 * They are stored in back/config/agents/*.json
 */

const DEFAULT_SYSTEM_PROMPT = "";

const schema = z.object({
	name: z.string().min(3),
	model: z.string(),
	systemPrompt: z.string().default(DEFAULT_SYSTEM_PROMPT)
});