package com.snake.suite.hub

import java.math.BigInteger
import java.security.MessageDigest
import java.util.Base64

/**
 * Checking the signature on the release index (Ed25519, RFC 8032), like the desktop
 * hub's signing.py. The release workflow signs index.json with a private key kept as
 * a GitHub secret; this app knows the matching public key (suite.json:
 * release.index_pubkey). An index whose signature does not match is not used, so a
 * tampered download list cannot point the hub at other files. Verification only, in
 * plain Kotlin: Android 11 has no Ed25519 of its own.
 */
object Signing {
    private val TWO: BigInteger = BigInteger.valueOf(2)   // BigInteger.TWO is newer than Android 11's runtime
    private val P: BigInteger = BigInteger.ONE.shiftLeft(255) - BigInteger.valueOf(19)
    private val L: BigInteger = BigInteger.ONE.shiftLeft(252) + BigInteger("27742317777372353535851937790883648493")
    private val D: BigInteger = (BigInteger.valueOf(-121665) * inv(BigInteger.valueOf(121666))).mod(P)
    private val SQRT_M1: BigInteger = TWO.modPow((P - BigInteger.ONE) / BigInteger.valueOf(4), P)
    private val G: Array<BigInteger>

    init {
        val gy = (BigInteger.valueOf(4) * inv(BigInteger.valueOf(5))).mod(P)
        val gx = recoverX(gy, 0)!!
        G = arrayOf(gx, gy, BigInteger.ONE, (gx * gy).mod(P))
    }

    private fun inv(x: BigInteger): BigInteger = x.modPow(P - TWO, P)

    private fun recoverX(y: BigInteger, sign: Int): BigInteger? {
        if (y >= P) return null
        val x2 = ((y * y - BigInteger.ONE) * inv(D * y * y + BigInteger.ONE)).mod(P)
        if (x2.signum() == 0) return if (sign != 0) null else BigInteger.ZERO
        var x = x2.modPow((P + BigInteger.valueOf(3)) / BigInteger.valueOf(8), P)
        if ((x * x - x2).mod(P).signum() != 0) x = (x * SQRT_M1).mod(P)
        if ((x * x - x2).mod(P).signum() != 0) return null
        if (x.testBit(0) != (sign == 1)) x = P - x
        return x
    }

    // Points in extended coordinates (X, Y, Z, T): x = X/Z, y = Y/Z, x*y = T/Z.
    private fun add(a: Array<BigInteger>, b: Array<BigInteger>): Array<BigInteger> {
        val aa = ((a[1] - a[0]) * (b[1] - b[0])).mod(P)
        val bb = ((a[1] + a[0]) * (b[1] + b[0])).mod(P)
        val cc = (TWO * a[3] * b[3] * D).mod(P)
        val dd = (TWO * a[2] * b[2]).mod(P)
        val e = bb - aa
        val f = dd - cc
        val g = dd + cc
        val h = bb + aa
        return arrayOf((e * f).mod(P), (g * h).mod(P), (f * g).mod(P), (e * h).mod(P))
    }

    private fun mul(s: BigInteger, point: Array<BigInteger>): Array<BigInteger> {
        var q = arrayOf(BigInteger.ZERO, BigInteger.ONE, BigInteger.ONE, BigInteger.ZERO)
        var p = point
        for (i in 0 until s.bitLength()) {
            if (s.testBit(i)) q = add(q, p)
            p = add(p, p)
        }
        return q
    }

    private fun equal(a: Array<BigInteger>, b: Array<BigInteger>): Boolean =
        (a[0] * b[2] - b[0] * a[2]).mod(P).signum() == 0 && (a[1] * b[2] - b[1] * a[2]).mod(P).signum() == 0

    private fun littleEndian(bytes: ByteArray): BigInteger = BigInteger(1, bytes.reversedArray())

    private fun decompress(s: ByteArray): Array<BigInteger>? {
        if (s.size != 32) return null
        val n = littleEndian(s)
        val sign = if (n.testBit(255)) 1 else 0
        val y = n.clearBit(255)
        val x = recoverX(y, sign) ?: return null
        return arrayOf(x, y, BigInteger.ONE, (x * y).mod(P))
    }

    /** Whether [signature] is the owner of [publicKey]'s signature on [message]. */
    fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean {
        if (publicKey.size != 32 || signature.size != 64) return false
        val a = decompress(publicKey) ?: return false
        val rBytes = signature.copyOfRange(0, 32)
        val r = decompress(rBytes) ?: return false
        val s = littleEndian(signature.copyOfRange(32, 64))
        if (s >= L) return false
        val sha = MessageDigest.getInstance("SHA-512")
        sha.update(rBytes)
        sha.update(publicKey)
        sha.update(message)
        val h = littleEndian(sha.digest()).mod(L)
        return equal(mul(s, G), add(r, mul(h, a)))
    }

    /** The same with the key and signature written as base64 (as suite.json and index.json.sig hold them). */
    fun verifyBase64(publicKey: String, message: ByteArray, signature: String): Boolean = try {
        verify(Base64.getDecoder().decode(publicKey.trim()), message, Base64.getDecoder().decode(signature.trim()))
    } catch (_: IllegalArgumentException) {
        false
    }
}
