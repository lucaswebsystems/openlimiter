# What is open, what is not, and why

OpenLimiter is open source under Apache 2.0. OpenLimiter Pro is a set of services
that run on servers, and the code that runs those servers is private.

This document exists because that split deserves a plain explanation rather than
a discovery. If you are deciding whether to depend on this project, the answer
you want is here.

## The line

**Public, in this repository, Apache 2.0:**

- The entire local product. Every connector, every meter, the whole engine.
- The command line tool and the statusline.
- Both dashboards, the desktop window and the web application.
- The agent context block and its routing advice.
- The Pro **client**: the sign in screen, the code that reads your entitlement,
  and the calls it makes to the Pro API.

**Private, in a separate repository:**

- The Pro server: database schema, edge functions, the payment webhook.
- Entitlement logic. The decision about whether an account is entitled is made
  on the server and never in the client.
- Every key and secret, which live in the hosting provider and nowhere else.

## Why the client is public even though it is part of a paid feature

Because hiding it would buy nothing, and because you should be able to read the
code that runs on your own machine.

The client asks a server whether an account is entitled. Publishing that code
tells you exactly what it sends and what it receives, which is the point: a
program that talks to a network on your behalf should be inspectable. Hiding it
would make the product less trustworthy without making it more profitable.

## The honest version of the moat

It would be easy to write that keeping the server private makes Pro impossible
to bypass. That would not be true, and this project does not say untrue things
about itself.

Anyone can read the public client, see the shape of the API, and stand up their
own server that returns an entitlement. Nothing stops that. For a determined
developer it is an afternoon.

What actually makes Pro worth paying for is not that the alternative is
impossible. It is that the alternative is running a multi device, encrypted,
always available sync service yourself, keeping it patched, and being your own
on call engineer for it. That costs more than ten dollars a month in time alone,
long before it costs anything in infrastructure.

If you would rather run it yourself, you genuinely can, and that is a feature of
this licence rather than a hole in it.

## Nothing local is ever paywalled

This is the oldest promise in the project and the one that constrains everything
else.

Every feature that runs on your machine is free, and stays free, and is covered
by a licence that cannot be revoked for the code already published. Pro sells
servers and service, never a switch that disables something you already had.

The practical consequence is what happens when a Pro subscription ends: the
server services stop, and **the application does not change**. Same connectors,
same meters, same command line tool, same dashboards, same everything. You keep
using the product exactly as you did before you ever had an account.

This is also the reason a local paywall would be pointless even if the promise
did not exist. This binary is Apache 2.0. A check that disabled a local feature
would be removed by the first person who forked the repository, and the only
people it would ever inconvenience are the ones who did not.

## The trial

When Pro ships, the first 30 days will be free, with no card required.

Three details that matter:

- The clock starts at **first sign in**, not at download. You can use OpenLimiter
  forever without an account, and until you make one, no clock is running.
- It is **30 days**, not "a month". A calendar month is 28 to 31 days depending
  on which one you are standing in, and a trial should not be vaguer than that.
- When it ends, the Pro server services stop and nothing local changes. There is
  no lockout, no downgrade of the application, and nothing to reinstall.

**Pro does not exist yet.** There is no checkout, no card form and no waiting
list, and no trial is running for anybody. Every sentence about Pro on the
website and in this document is written in the future tense on purpose. When
that stops being true, this section is one of the things that changes.

## If this project is ever abandoned

The local product is Apache 2.0 and published. That cannot be taken back, and it
does not depend on anybody continuing to care.

The server side is a different question, and it is one every paid service should
answer before it takes money rather than after. The commitments will be written
here before the first payment is accepted, not after.

## Questions this document should answer but does not yet

Held open honestly rather than left implied:

- The merchant of record, the jurisdiction, and who handles VAT and sales tax.
- Refunds, cancellation and what happens to a disputed payment.
- The privacy notice, the data deletion path, and how long payment records are
  kept.

None of these are optional and none of them are written yet. They are gates on
the first Pro release, not follow ups after it.
