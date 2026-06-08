# Safety Patterns for Low-Level Solana Programs (Blog Version)

This post walks through a few safety patterns we used while building [solana-payment-channels](https://github.com/Moonsong-Labs/solana-payment-channels), a low-level Solana program written with Pinocchio which implements the Solana [protocol specification](https://github.com/tempoxyz/mpp-specs/pull/201) for [MPP sessions](https://mpp.dev/payment-methods/tempo/session?q=spec). Some of these patterns come from working in a zero-copy architecture, where instruction data and account data are parsed directly from raw bytes. Others come from the payment-channel protocol itself, where replay protection and account lifecycle decisions matter.

The short version:

- Pinocchio gives us tight control over compute, memory layout, and data flow, but requires explicit validation discipline.
- We represented instruction data as byte-backed structs to avoid alignment surprises.
- We introduced a project-local unsafe trait, `Transmutable`, to make raw-byte layout assumptions explicit and auditable.
- We added a Token-2022 extension filter (TLV walker + whitelist) to reject unsupported extensions early.
- We used typestate so business logic only receives validated accounts.
- At the protocol layer, we tombstone closed channels so old vouchers cannot be replayed against reused PDAs.

### Why Pinocchio

Pinocchio is a performance-oriented data structure and data flow model. The tradeoff is doing more account parsing, layout discipline, and manual validation yourself — guardrails that higher-level frameworks typically provide by default such as Anchor.

For this project (solana-payment-channels), we optimized for speed and cost, and adopted a zero-copy approach that keeps account and instruction parsing explicit. We also let go of our beloved heap and went no_std to squeeze out more performance since this program is expecting to have a high volume of traffic.

Pinocchio does none of the heavy lifting for you, it is basically a zero-copy model to work with Accounts passed in the Transaction. This optimization leads to difficulties with parsing in a safe way from raw bytes to a Struct based representation of the data to work with in the program instructions.

### Making raw bytes boring

There was no way of achieving this cleanly without some tradeoffs when it comes to parsing the data into structs safely based on their memory alignment and size. For example using `#[repr(C, packed)]` would allow you to add different aligned field types in any order without worrying about additional byte padding added by the compiler.

```rust
use core::mem::{align_of, size_of};

#[repr(C)]
struct WithoutPacked {
    a: u8,
    // compiler inserts 7 bytes of padding here to align `b` to 8
    b: u64,
}

#[repr(C, packed)]
struct WithPacked {
    a: u8,
    // no padding, `b` starts immediately after `a`
    b: u64,
}

fn main() {
    assert_eq!(align_of::<WithoutPacked>(), 8);
    assert_eq!(size_of::<WithoutPacked>(), 16); // 1 + 7 padding + 8

    assert_eq!(align_of::<WithPacked>(), 1);
    assert_eq!(size_of::<WithPacked>(), 9); // 1 + 8
}
```

Without packing, if you care about reducing the size, you would need to order your fields from largest to smallest to reduce padding, but this means that any field added to the struct in the future would add padding if it is larger than the smallest aligned field.

With packing, you are avoiding any additional padding, but it is difficult to work with safely in Rust because taking references to unaligned fields can be undefined behavior and often forces extra copying or manual byte parsing.

There is a third option which is the one we ended up with. A struct without packing, and expanding all fields to 1-byte aligned fields. Declaring fields such as a `u64`, would be declared instead as `[u8; 8]`. Here is an example of one of the argument structs for the `open` instruction.

```rust
#[repr(transparent)]
#[derive(Debug, Clone, Copy)]
struct LeU64([u8; size_of::<u64>()]);

impl LeU64 {
    #[inline(always)]
    fn get(&self) -> u64 {
        u64::from_le_bytes(self.0)
    }
}

#[repr(transparent)]
#[derive(Debug, Clone, Copy)]
struct LeU32([u8; size_of::<u32>()]);

impl LeU32 {
    #[inline(always)]
    fn get(&self) -> u32 {
        u32::from_le_bytes(self.0)
    }
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct OpenArgsHeader {
    /// PDA disambiguator stored in [`Channel::salt`](crate::Channel::salt).
    salt: LeU64,
    /// Initial escrow amount and ceiling for [`Channel::settled`](crate::Channel::settled).
    deposit: LeU64,
    /// Grace duration, in seconds.
    grace_period: LeU32,
}

```

This allows us to add any additional field types without worrying about alignment or size. The only drawback is you have to convert to the actual type when you want to work with it. From the example above, we call `get` methods to decode from little-endian bytes, the raw byte slice, to `u32`, or `u64`.

To ensure that in the future any data structures we work with in our program instructions follow this pattern, we resorted to creating `Transmutable` trait which guarantees at compile time that the type that implements this trait is 1-byte aligned and is “safe” to transmute to and from raw bytes based on its size.

Below is the `Transmutable` trait definition which implementors must set the `LEN` associated constant for size checks and its load methods which have compile time checks to assert the alignment of `T`.

```rust
/// Marker for types castable from a raw byte slice.
///
/// # Safety
///
/// Implementers must guarantee:
/// - `align_of::<Self>() == 1` (enforced at every [`load`] call site by a
///   `const { assert!(...) }`).
/// - `size_of::<Self>() == Self::LEN` and the struct contains no implicit
///   padding bytes — i.e. every field is itself align-1.
pub unsafe trait Transmutable {
    /// On-wire byte length of the type.
    const LEN: usize;

    /// Reverse of [`load`]: reinterpret `self` as its `Self::LEN` raw bytes.
    #[inline(always)]
    fn as_bytes(&self) -> &[u8]
    where
        Self: Sized,
    {
        const {
            assert!(
                core::mem::align_of::<Self>() == 1,
                "Transmutable types must have alignment 1",
            );
        };
        unsafe { core::slice::from_raw_parts(core::ptr::from_ref(self).cast::<u8>(), Self::LEN) }
    }
}

/// Reinterpret `bytes` as `&T`. Validates length only and alignment.
///
/// # Safety
///
/// Caller must ensure `bytes` is a valid bit-pattern for `T`.
#[inline(always)]
pub unsafe fn load<T: Transmutable>(bytes: &[u8]) -> Result<&T, ProgramError> {
    const {
        assert!(
            core::mem::align_of::<T>() == 1,
            "Transmutable types must have alignment 1",
        );
    };
    if bytes.len() != T::LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(unsafe { &*bytes.as_ptr().cast::<T>() })
}

/// Reinterpret `bytes` as `&mut T`. Validates length only and alignment.
///
/// # Safety
///
/// Caller must ensure `bytes` is a valid bit-pattern for `T`.
#[inline(always)]
pub unsafe fn load_mut<T: Transmutable>(bytes: &mut [u8]) -> Result<&mut T, ProgramError> {
    // ... same checks as load()
    
    Ok(unsafe { &mut *bytes.as_mut_ptr().cast::<T>() })
}
```

Below is an example of one of the argument structs for the `top_up` instruction. Since it implements `Transmutable` it is guaranteed that any byte-backed fields we add or modify to the struct in the future will flag it if it is no longer 1-byte aligned. And size of `LEN` is set to `size_of::<Self>()` which means it will never drift from reality. With this in place, we can “safely” load raw bytes into the struct.

```rust
#[repr(C)]
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "idl", derive(CodamaType))]
pub struct TopUpArgs {
    /// Base-unit amount to pull from the payer's token account into escrow.
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub amount: [u8; 8],
}

impl TopUpArgs {
    pub const LEN: usize = size_of::<Self>();

    #[inline(always)]
    pub fn amount(&self) -> u64 {
        u64::from_le_bytes(self.amount)
    }

    pub fn load(data: &[u8]) -> Result<&Self, ProgramError> {
        unsafe { load::<Self>(data) }.map_err(|_| ProgramError::InvalidInstructionData)
    }
}

unsafe impl Transmutable for TopUpArgs {
    const LEN: usize = size_of::<Self>();
}

pub fn process(
    _program_id: &Address,
    accounts: &mut [AccountView],
    args: &TopUpArgs,
) -> ProgramResult {
		// ...

		// Decode raw byte slice to u64
    let amount = args.amount();
    if amount == 0 {
        return Err(PaymentChannelsError::DepositMustBeNonZero.into());
    }
    
    // ...
}
```

If you haven’t noticed, I have been putting the word, “safely”, in quotes because this solution still does not guarantee that the bytes can be transmuted into any type. For example a byte value which isn’t `0` or `1` cannot be transmuted to a valid 1-byte aligned `bool`.

### Rebuilding Anchor-style account safety with typestate

Choosing Pinocchio for our program framework not only meant reading and working with raw instruction data, but also raw account data. Going with the Anchor framework would have taken care of this with macro magic to abstract away the complexity. 

To achieve the same level of abstraction and ease that we would normally have gotten for free with Anchor, we leveraged Rust type state patterns for gated business flows based on the following zero-sized type (ZST) markers; `Unchecked` and `Checked`.

The rule was simple: raw accounts enter the instruction as `Unchecked`; only validation constructors can produce `Checked`; business logic only accepts `Checked` contexts.

Here is what this looks like in practice:

```rust
// Raw AccountView values enter as Unchecked.
pub struct Unchecked;
pub struct Checked;

pub struct PayerTokenAccountView<'a, S = Unchecked> {
    inner: &'a mut AccountView,
    _s: PhantomData<S>,
}

// `.into()` wraps a raw account as a typed Unchecked account view.
impl<'a> From<&'a mut AccountView> for PayerTokenAccountView<'a, Unchecked> {
    fn from(value: &'a mut AccountView) -> Self {
        Self {
            inner: value,
            _s: Default::default(),
        }
    }
}

pub struct PayerContext<'a> {
    pub payer: PayerAccountView<'a, Checked>,
    pub payer_token_account: PayerTokenAccountView<'a, Checked>,
}

impl<'a> PayerContext<'a> {
    pub fn new(
        payer: PayerAccountView<'a, Unchecked>,
        payer_token_account: PayerTokenAccountView<'a, Unchecked>,
        token_ctx: &TokenContext<'a>,
    ) -> Result<Self, PaymentChannelsError> {
        // Validates ATA address, mint, owner, initialized state,
        // and allowed Token-2022 extensions.
        payer_token_account
            .validate_as_ata_checked(payer.address(), token_ctx)?;

        // Validation succeeded, so we promote Unchecked -> Checked.
        Ok(Self {
            payer: PayerAccountView {
                inner: payer.inner,
                _s: Default::default(),
            },
            payer_token_account: PayerTokenAccountView {
                inner: payer_token_account.inner,
                _s: Default::default(),
            },
        })
    }
}

pub fn process(accounts: &mut [AccountView], args: &TopUpArgs) -> ProgramResult {
    // Raw accounts are parsed into typed Unchecked views.
    let accs = TopUpAccounts::try_from(accounts)?;

    // Validation constructors consume Unchecked views.
    let token_ctx = TokenContext::new(accs.mint, accs.token_program)?;
    let channel_ctx =
        ChannelContext::new(accs.channel, accs.channel_token_account, token_ctx)?;
    let payer_ctx =
        PayerContext::new(accs.payer, accs.payer_token_account, &channel_ctx.token_ctx)?;

    // Sensitive logic only receives the Checked contexts.
    transfer_from_payer(&payer_ctx, &channel_ctx, args.amount())
}

fn transfer_from_payer(
    payer_ctx: &PayerContext<'_>,
    channel_ctx: &ChannelContext<'_>,
    amount: u64,
) -> ProgramResult {
    // `payer_ctx` can only be constructed after validating the payer ATA.
    // At this point we know `from` belongs to the payer and uses the expected mint.
    //
    // `channel_ctx` can only be constructed after validating the escrow ATA.
    // At this point we know `to` belongs to the channel PDA and uses the same mint.
    TransferChecked {
        from: &payer_ctx.payer_token_account,
        mint: &channel_ctx.token_ctx.mint,
        to: &channel_ctx.channel_token_account,
        authority: &payer_ctx.payer,
        amount,
        decimals: channel_ctx.token_ctx.decimals,
        token_program: channel_ctx.token_ctx.token_program.address(),
    }
    .invoke()
}
```

All of our business logic is gated based on the `Checked` accounts. This reduces most of the fallible surface which can arise if you miss some important validations, such as: ATA address derivation, token account holds the same mint as the channel, allowed Token 2022 extensions, etc.

### Token 2022 extension filter

Token 2022 (T22) has a long list of extensions, several of which have a negative impact for transactions that require token precise accounting and transfer availability.

In the solana-payment-channels program, it is important to keep track of how much has been paid out against the settled watermark. T22 token account extensions break this in different ways: `TransferFeeAmount` skims units on every transfer, making exact-amount accounting painful, and `NonTransferableAccount` makes transfers impossible outright, just to name a couple.

We needed a method to validate mint and token account extensions based on our configured whitelists.

Since there are two different sets of valid extensions between both account types, i.e. mint and token account, we chose to introduce an `ExtensionPolicy` trait which would give us the capability to cleanly disambiguate between both extension whitelists for both mint and token account kinds.

The extensions configured per mint and token account are encoded in a variable-length Type-Length-Value (TLV) format. No well-maintained crate offered a no_std, zero-copy way to parse and traverse them, so we wrote our own TLV walker. It parses and traverses the dynamic list of extensions that needed to be validated by the `ExtensionPolicy`.

Here is the global loop which advances the walker until there are no more extensions, a data format issue or a non-whitelisted extension. The TLV walker is omitted due to its verbosity.

```rust
/// Walks the Token-2022 TLV trailer and rejects any type not whitelisted by
/// `P`. Extension uniqueness is enforced at initialization.
pub(crate) fn scan_tlv_extensions<P: ExtensionPolicy>(
    trailer: &[u8],
) -> Result<(), TokenExtensionError> {
    for kind in ExtensionTlv::new(trailer) {
        if !P::allows(kind?) {
            return Err(TokenExtensionError::UnsupportedTokenExtension);
        }
    }
    Ok(())
}

impl<'a> Iterator for ExtensionTlv<'a> {
    type Item = Result<ExtensionType, TokenExtensionError>;

    fn next(&mut self) -> Option<Self::Item> {
        match self.advance_one() {
            Ok(Some(kind)) => Some(Ok(kind)),
            Ok(None) => None,
            Err(e) => {
                // Sticky-fail: future calls land on the all-zero short-tail path and end.
                self.remaining = &[];
                Some(Err(e))
            }
        }
    }
}
```

The TLV walker is implemented inside `advance_one` which returns: the next extension in the list, none if there are no more and an error due to data encoding problems during parsing. The global loop then calls `P::allows` to validate the extension against our mint or token account whitelist.

The `ExtensionPolicy` trait simply exposes an `allows` method which returns `true` for an extension that is part of the whitelist and `false` if otherwise.

```rust
/// Whitelist of TLV extension types accepted for a given account kind.
/// Stateless: implementors are zero-sized type tags driven via turbofish on
/// [`scan_tlv_extensions`].
pub(crate) trait ExtensionPolicy {
    fn allows(kind: ExtensionType) -> bool;
}

pub(crate) struct MintExtensionPolicy;
pub(crate) struct TokenAccountExtensionPolicy;

impl ExtensionPolicy for MintExtensionPolicy {
    fn allows(kind: ExtensionType) -> bool {
        matches!(
            kind,
            ExtensionType::MetadataPointer
                | ExtensionType::TokenMetadata
                | ExtensionType::GroupPointer
                | ExtensionType::TokenGroup
                | ExtensionType::GroupMemberPointer
                | ExtensionType::TokenGroupMember,
        )
    }
}

impl ExtensionPolicy for TokenAccountExtensionPolicy {
    fn allows(kind: ExtensionType) -> bool {
        matches!(kind, ExtensionType::ImmutableOwner)
    }
}
```

The rest lives in the [token module](https://github.com/Moonsong-Labs/solana-payment-channels/blob/main/program/payment_channels/src/instructions/helpers/token.rs).

### Why we tombstone closed channels

In the [MPP](https://mpp.dev/) protocol, clients sign vouchers to pay for resource units provided by the server, e.g. tokens from an inference server. These vouchers are submitted by the server on chain to increase the settled watermark, tracking how much was settled on chain and later distribute the unpaid amount to the payee and potentially additional recipients based on a split configuration.

Vouchers carry important data which is critical for the program to validate before increasing the watermark.

```rust
#[repr(C)]
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "idl", derive(CodamaType))]
pub struct VoucherArgs {
    /// Replay scope; must equal the [`Channel`](crate::Channel) PDA.
    pub channel_id: Address,
    /// Monotonic watermark. Must satisfy
    /// [`settled`](crate::Channel::settled) `< cumulative_amount ≤`
    /// [`deposit`](crate::Channel::deposit); the strict increase also
    /// serves as the implicit nonce.
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    cumulative_amount: [u8; 8],
    /// Unix-seconds TTL; `0` means no expiry. Freshness:
    /// `expires_at == 0 || now < expires_at`.
    #[cfg_attr(feature = "idl", codama(type = number(i64)))]
    expires_at: [u8; 8],
    /// Chain binding; must equal this cluster's
    /// [`CHAIN_ID`](crate::CHAIN_ID) (its genesis hash). Stops a voucher
    /// signed for one cluster from being replayed against an
    /// identically-addressed channel on another.
    pub chain_id: Address,
}
```

The `channel_id` is what ties a voucher to a specific opened channel between a client and server, akin to a session opened with your favourite agent. That is already a useful safety measure because the signature is scoped to one channel but it does not in itself prevent replay attacks if channel PDAs could be re-opened under the same channel ID, and having old vouchers passing as valid ones.

Once a channel is finalized, the active channel state is no longer needed and to avoid this attack vector, we keep a minimal tombstone: the channel account remains allocated, we zero out all the data, and leave behind a single discriminator byte `u8` which maps to an enum variant `Closed`.

This leaves a tiny, refundable rent-exempt deposit behind, but prevents the PDA from being reused for a fresh channel.

### Conclusion

Pinocchio gives you speed and explicit control, but it also pushes safety back onto you: every byte you parse and every account you touch needs deliberate validation. The patterns above include byte-backed structs with auditable layout assumptions, an explicit Transmutable boundary, and typestate-validated account contexts. Together they turn “raw bytes and raw accounts” into inputs that are predictable, constrained, and hard to misuse. Finally, higher-level constraints (strict Token-2022 extension filtering) and protocol lifecycle choices (tombstoning closed channels) keep correctness intact over time by shutting down accounting, transfer-availability, replay, and account-reuse hazards.