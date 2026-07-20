import { describe, expect, it } from "vitest";
import { parseVCard } from "../src/vcard";

describe("VCard parser", () => {
  it("parses folded lines, grouped properties and parameters containing colons", () => {
    const card = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Max ",
      " Mustermann",
      "ORG:InHaus AI;Produktion",
      'item1.TEL;TYPE="CELL:VOICE";VALUE=uri:tel:+49 123 456',
      "EMAIL;TYPE=INTERNET;VALUE=uri:mailto:max@example.com",
      "END:VCARD",
    ].join("\r\n");

    expect(parseVCard(card)).toEqual({
      name: "Max Mustermann",
      organization: "InHaus AI · Produktion",
      phones: ["+49 123 456"],
      emails: ["max@example.com"],
    });
  });

  it("uses the structured N field when FN is missing", () => {
    const card = [
      "BEGIN:VCARD",
      "N:Doe\\;Senior;Jane\\, Ann;M.;Dr.;PhD",
      "END:VCARD",
    ].join("\n");

    expect(parseVCard(card)).toEqual({
      name: "Dr. Jane, Ann M. Doe;Senior PhD",
      phones: [],
      emails: [],
    });
  });

  it("decodes escaped backslashes, commas, semicolons and newlines", () => {
    const card = [
      "BEGIN:VCARD",
      "FN:Jane\\nDoe",
      "ORG:Acme\\, Inc.\\; Europe\\\\Lab",
      "END:VCARD",
    ].join("\n");

    expect(parseVCard(card)).toEqual({
      name: "Jane\nDoe",
      organization: "Acme, Inc.; Europe\\Lab",
      phones: [],
      emails: [],
    });
  });

  it("deduplicates contact values and compares email addresses case-insensitively", () => {
    const card = [
      "BEGIN:VCARD",
      "FN:Jane Doe",
      "TEL:+49 123",
      "TEL;TYPE=CELL:+49 123",
      "EMAIL:Jane@example.com",
      "EMAIL;TYPE=HOME:jane@example.com",
      "END:VCARD",
    ].join("\n");

    expect(parseVCard(card)).toEqual({
      name: "Jane Doe",
      phones: ["+49 123"],
      emails: ["Jane@example.com"],
    });
  });

  it("uses a contact value as the required display name when no name is present", () => {
    expect(parseVCard("BEGIN:VCARD\nTEL;TYPE=CELL:tel:+49 987\nEND:VCARD")).toEqual({
      name: "+49 987",
      phones: ["+49 987"],
      emails: [],
    });
  });

  it("marks a VCF containing multiple contact blocks instead of hiding them", () => {
    const card = [
      "BEGIN:VCARD",
      "FN:Max Mustermann",
      "END:VCARD",
      "BEGIN:VCARD",
      "FN:Jane Doe",
      "END:VCARD",
    ].join("\n");
    expect(parseVCard(card)).toEqual({
      name: "Max Mustermann",
      phones: [],
      emails: [],
      additionalContacts: 1,
      additionalContactNames: ["Jane Doe"],
    });
  });

  it("decodes quoted-printable UTF-8 values and soft line breaks", () => {
    const card = [
      "BEGIN:VCARD",
      "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:J=C3=B6rg=",
      " =20M=C3=BCller",
      "ORG;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:B=C3=BCro",
      "END:VCARD",
    ].join("\r\n");
    expect(parseVCard(card)).toEqual({
      name: "Jörg Müller",
      organization: "Büro",
      phones: [],
      emails: [],
    });
  });

  it("decodes base64-encoded contact names", () => {
    expect(parseVCard([
      "BEGIN:VCARD",
      "FN;CHARSET=UTF-8;ENCODING=B:SsO2cmc=",
      "END:VCARD",
    ].join("\n"))).toEqual({
      name: "Jörg",
      phones: [],
      emails: [],
    });
  });

  it("keeps addresses, websites, birthdays and notes from contact cards", () => {
    expect(parseVCard([
      "BEGIN:VCARD",
      "FN:Jane Doe",
      "ADR;TYPE=HOME:;;Musterstraße 1;Berlin;;10115;Deutschland",
      "URL:https://example.com/contact",
      "BDAY:1990-05-04",
      "NOTE:Erste Zeile\\nZweite Zeile",
      "END:VCARD",
    ].join("\n"))).toEqual({
      name: "Jane Doe",
      phones: [],
      emails: [],
      addresses: ["Musterstraße 1, Berlin, 10115, Deutschland"],
      urls: ["https://example.com/contact"],
      birthday: "1990-05-04",
      note: "Erste Zeile\nZweite Zeile",
    });
  });

  it("ignores unsafe or malformed contact URLs without rejecting the contact", () => {
    expect(parseVCard("BEGIN:VCARD\nFN:Jane Doe\nURL:javascript:alert(1)\nEND:VCARD")).toEqual({
      name: "Jane Doe",
      phones: [],
      emails: [],
    });
  });

  it("returns undefined when no usable name or contact exists", () => {
    expect(parseVCard("BEGIN:VCARD\nVERSION:4.0\nNOTE:only metadata\nEND:VCARD")).toBeUndefined();
    expect(parseVCard("BEGIN:VCARD\nFN:   \nTEL:   \nEND:VCARD")).toBeUndefined();
  });

  it("uses the first usable contact when an earlier block contains only metadata", () => {
    expect(parseVCard([
      "BEGIN:VCARD",
      "VERSION:4.0",
      "NOTE:metadata only",
      "END:VCARD",
      "BEGIN:VCARD",
      "FN:Jane Doe",
      "EMAIL:jane@example.com",
      "END:VCARD",
    ].join("\n"))).toEqual({
      name: "Jane Doe",
      phones: [],
      emails: ["jane@example.com"],
    });
  });

  it("fails safely when input, line or field limits are exceeded", () => {
    expect(parseVCard(`BEGIN:VCARD\nFN:${"x".repeat(1024 * 1024)}\nEND:VCARD`)).toBeUndefined();
    expect(parseVCard(["BEGIN:VCARD", "FN:Safe", ...Array.from({ length: 1100 }, () => "NOTE:x"), "END:VCARD"].join("\n"))).toBeUndefined();
  });
});
