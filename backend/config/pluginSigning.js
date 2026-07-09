// Public key for verifying installed plugin (.iccplugin) signatures (contract
// C9.2). Pairs with LicenseTools/keys/plugin-signing-private.pem — this is a
// DIFFERENT keypair from the product license signing key in services/license.js.
module.exports = {
  publicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAbGr+XfQFSSubFefkZTo2FrSHUckl383jUH1o4qd2FCI=
-----END PUBLIC KEY-----`,
};
