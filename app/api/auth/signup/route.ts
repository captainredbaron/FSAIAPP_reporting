import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

export async function POST(request: Request) {
  try {
    const body = signupSchema.parse(await request.json());

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email: body.email,
      password: body.password,
      email_confirm: true
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({
      userId: data.user?.id,
      message: "Account created. You can sign in now."
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      const firstIssue = error.issues[0];
      return NextResponse.json(
        { error: firstIssue?.message ?? "Invalid email or password format." },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: "Unable to create account." },
      { status: 500 }
    );
  }
}
