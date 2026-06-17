
export type UpdateKeypair = {
  publicKeyB64: string;
  privateKeyPkcs8B64: string;
};

/** Generates an Ed25519 keypair as base64 (raw public, PKCS8 private). */
export async function generateUpdateKeypair(): Promise<UpdateKeypair> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const rawPub = new Uint8Array(
    await crypto.subtle.exportKey("raw", kp.publicKey)
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", kp.privateKey)
  );
  return {
    publicKeyB64: Buffer.from(rawPub).toString("base64"),
    privateKeyPkcs8B64: Buffer.from(pkcs8).toString("base64"),
  };
}

if (import.meta.main) {
  const { publicKeyB64, privateKeyPkcs8B64 } = await generateUpdateKeypair();
  process.stdout.write(
    [
      "# Update signing keypair (Ed25519)",
      "# 1. Put the PUBLIC key in src/update/pubkey.ts (UPDATE_PUBLIC_KEY_B64).",
      "# 2. Store the PRIVATE key as the GitHub secret CLIMON_UPDATE_PRIVATE_KEY.",
      "",
      `PUBLIC_KEY_B64=${publicKeyB64}`,
      `PRIVATE_KEY_PKCS8_B64=${privateKeyPkcs8B64}`,
      "",
    ].join("\n")
  );
}
