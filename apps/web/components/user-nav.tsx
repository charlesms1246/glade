import Link from "next/link";
import { connection } from "next/server";
import { sessionUserId } from "@/lib/server/session";
import { SignOut } from "./sign-out";

export async function UserNav() {
  // Session checks compare against the clock, so this renders per request.
  await connection();
  const uid = await sessionUserId();
  if (!uid) {
    return (
      <Link href="/login" className="rounded-full bg-forest px-4 py-1.5 text-paper hover:bg-forest-deep">
        Sign in
      </Link>
    );
  }
  return (
    <>
      {[
        { href: "/home", label: "Home" },
        { href: "/buy", label: "Buy" },
        { href: "/shield", label: "Shield" },
        { href: "/floor", label: "Floor" },
        { href: "/activity", label: "Activity" },
      ].map((n) => (
        <Link key={n.href} href={n.href} className="hover:text-forest">
          {n.label}
        </Link>
      ))}
      <SignOut />
    </>
  );
}
