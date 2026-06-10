const textDecoder = new TextDecoder("utf-8");

export async function parseBackupFile(file) {
  const buffer = await file.arrayBuffer();
  const entries = readZipEntries(buffer);
  const dbEntry = entries
    .filter((entry) => /Db\.xml$/i.test(entry.name))
    .sort((a, b) => b.uncompressedSize - a.uncompressedSize)[0];

  if (!dbEntry) {
    throw new Error("No database XML ending in Db.xml was found in this backup.");
  }

  const xmlText = await readEntryText(buffer, dbEntry);
  const xml = new DOMParser().parseFromString(xmlText, "application/xml");
  const error = xml.querySelector("parsererror");
  if (error) {
    throw new Error("The database XML could not be parsed.");
  }

  return parseSystem(xml, dbEntry.name);
}

function readZipEntries(buffer) {
  const view = new DataView(buffer);
  const eocdOffset = findEndOfCentralDirectory(view);
  if (eocdOffset < 0) {
    throw new Error("The selected file is not a readable zip archive.");
  }

  let totalEntries = view.getUint16(eocdOffset + 10, true);
  let centralOffset = view.getUint32(eocdOffset + 16, true);
  if (totalEntries === 0xffff || centralOffset === 0xffffffff) {
    const zip64 = findZip64CentralDirectory(view, eocdOffset);
    totalEntries = zip64.totalEntries;
    centralOffset = zip64.centralOffset;
  }
  const entries = [];
  let offset = centralOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("The zip central directory is damaged or unsupported.");
    }

    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    let compressedSize = view.getUint32(offset + 20, true);
    let uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    let localHeaderOffset = view.getUint32(offset + 42, true);
    const nameBytes = new Uint8Array(buffer, offset + 46, nameLength);
    const name = new TextDecoder(flags & 0x0800 ? "utf-8" : "utf-8").decode(nameBytes);
    const extraOffset = offset + 46 + nameLength;
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      const zip64Values = parseZip64Extra(view, extraOffset, extraLength);
      let cursor = 0;
      if (uncompressedSize === 0xffffffff) uncompressedSize = Number(zip64Values[cursor++]);
      if (compressedSize === 0xffffffff) compressedSize = Number(zip64Values[cursor++]);
      if (localHeaderOffset === 0xffffffff) localHeaderOffset = Number(zip64Values[cursor++]);
    }

    entries.push({ name, method, flags, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(view) {
  const min = Math.max(0, view.byteLength - 0xffff - 22);
  for (let offset = view.byteLength - 22; offset >= min; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      return offset;
    }
  }
  return -1;
}

async function readEntryText(buffer, entry) {
  if (entry.flags & 0x0001) {
    throw new Error(`Encrypted zip entries are unsupported (${entry.name}). Re-export without encryption.`);
  }
  const view = new DataView(buffer);
  const offset = entry.localHeaderOffset;
  if (view.getUint32(offset, true) !== 0x04034b50) {
    throw new Error("The zip local file header is damaged or unsupported.");
  }

  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + nameLength + extraLength;
  if ((entry.flags & 0x0008) && !entry.compressedSize) {
    throw new Error(`Zip data-descriptor entry has no known compressed size (${entry.name}).`);
  }
  const compressed = buffer.slice(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) {
    return textDecoder.decode(compressed);
  }

  if (entry.method === 8 && "DecompressionStream" in window) {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const inflated = await new Response(stream).arrayBuffer();
    return textDecoder.decode(inflated);
  }

  throw new Error("This browser cannot decompress the backup zip. Try current Chrome, Edge, or Firefox.");
}

function parseSystem(xml, sourceEntry) {
  const root = xml.documentElement;
  const tenant = children(first(root, "Tenants"))[0];
  const dnContainer = first(tenant, "DN");
  const system = {
    sourceEntry,
    version: text(first(root, "header"), "version"),
    officeHours: parseTenantOfficeHours(tenant),
    trunks: [],
    ivrs: {},
    ringGroups: {},
    queues: {},
    extensions: {},
    routePoints: {},
  };

  if (!dnContainer) {
    return system;
  }

  for (const child of children(dnContainer)) {
    if (child.tagName === "Extension") {
      const number = text(child, "Number");
      system.extensions[number] = {
        number,
        firstName: text(child, "FirstName"),
        lastName: text(child, "LastName"),
        email: text(child, "EmailAddress"),
        enabled: /^true$/i.test(text(child, "Enabled")),
        currentProfile: text(child, "CurrentProfile"),
        profiles: parseForwardingProfiles(child),
      };
    } else if (child.tagName === "IVR") {
      const number = text(child, "Number");
      system.ivrs[number] = {
        number,
        name: text(child, "Name"),
        prompt: text(child, "PromptFilename"),
        timeout: text(child, "Timeout"),
        timeoutForwardType: text(child, "TimeoutForwardType"),
        timeoutDestination: destinationFromTypeAndDn(text(child, "TimeoutForwardType"), text(child, "TimeoutForwardDN")),
        workingHours: parseWorkingHours(child),
        officeRoute: parseRouteString(text(child, "OfficeHoursRoute")),
        outOfHoursRoute: parseRouteString(text(child, "OutOfOfficeHoursRoute")),
        breakRoute: parseRouteString(text(child, "BreakTimeRoute")),
        holidaysRoute: parseRouteString(text(child, "HolidaysRoute")),
        options: descendants(child, "IVRForward").map((option) => ({
          digit: text(option, "Number"),
          destination: destinationFromTypeAndDn(text(option, "ForwardType"), text(option, "ForwardDN")),
        })),
      };
    } else if (child.tagName === "RingGroup") {
      const number = text(child, "Number");
      system.ringGroups[number] = {
        number,
        name: text(child, "Name"),
        strategy: text(child, "RingStrategy"),
        ringTime: text(child, "RingTime"),
        members: children(first(child, "Members"), "Member").map((m) => m.getAttribute("DN")).filter(Boolean),
        workingHours: parseWorkingHours(child),
        noAnswer: parseForwardTypeDestination(firstWithFallback(child, ["NoAnswerDestination", "Destination", "NoAnswerRoute"])),
        officeHoursDestination: parseForwardTypeDestination(firstWithFallback(child, ["OfficeHoursDestination", "OfficeHoursRoute"])),
        outOfOfficeHoursDestination: parseForwardTypeDestination(firstWithFallback(child, ["OutOfOfficeHoursDestination", "OutOfOfficeHoursRoute"])),
        holidaysDestination: parseForwardTypeDestination(firstWithFallback(child, ["HolidaysDestination", "HolidaysRoute"])),
      };
    } else if (child.tagName === "Queue") {
      const number = text(child, "Number");
      system.queues[number] = {
        number,
        name: text(child, "Name"),
        polling: text(child, "PollingStrategy"),
        ringTimeout: text(child, "RingTimeout"),
        masterTimeout: text(child, "MasterTimeout"),
        introFile: text(child, "IntroFile"),
        onHoldFile: text(child, "OnHoldFile"),
        members: children(first(child, "Members"), "Member").map((m) => m.getAttribute("DN")).filter(Boolean),
        workingHours: parseWorkingHours(child),
        timeoutDestination: parseForwardTypeDestination(firstWithFallback(child, ["TimeoutDestination", "Destination", "NoAnswerDestination"])),
        officeHoursDestination: parseForwardTypeDestination(firstWithFallback(child, ["OfficeHoursDestination", "OfficeHoursRoute"])),
        outOfOfficeHoursDestination: parseForwardTypeDestination(firstWithFallback(child, ["OutOfOfficeHoursDestination", "OutOfOfficeHoursRoute"])),
        holidaysDestination: parseForwardTypeDestination(firstWithFallback(child, ["HolidaysDestination", "HolidaysRoute"])),
      };
    } else if (child.tagName === "RoutePoint") {
      system.routePoints[text(child, "Number")] = text(child, "Name");
    }
  }

  for (const child of children(dnContainer, "ExternalLine")) {
    const gateway = first(child, "Gateway");
    const trunk = {
      number: text(child, "Number"),
      name: text(gateway, "Name") || text(child, "Gateway") || text(child, "Name"),
      direction: text(child, "Direction"),
      dids: text(child, "DIDNumbers").split(",").map((did) => did.trim()).filter(Boolean),
      rules: [],
    };

    const routingContainers = [
      first(child, "RoutingRules"),
      first(child, "ExternalLineRules"),
      first(child, "InboundRules"),
    ].filter(Boolean);
    const rules = routingContainers.flatMap((container) => children(container, "ExternalLineRule"));
    if (!rules.length) {
      rules.push(...descendants(child, "ExternalLineRule"));
    }

    for (const rule of rules) {
      const condition = first(first(rule, "Conditions"), "Condition");
      const destinations = first(rule, "ForwardDestinations") || first(rule, "Destinations") || rule;
      trunk.rules.push({
        name: text(rule, "RuleName"),
        condition: condition?.getAttribute("Type") || "",
        match: text(rule, "Data"),
        office: parseDestinationElement(first(destinations, "OfficeHoursDestination")),
        outOfHours: parseDestinationElement(first(destinations, "OutOfOfficeHoursDestination")),
        holidays: parseDestinationElement(first(destinations, "HolidaysDestination")),
      });
    }

    system.trunks.push(trunk);
  }

  return system;
}

function parseZip64Extra(view, offset, length) {
  const end = offset + length;
  let cursor = offset;
  while (cursor + 4 <= end) {
    const headerId = view.getUint16(cursor, true);
    const dataSize = view.getUint16(cursor + 2, true);
    const dataStart = cursor + 4;
    const dataEnd = dataStart + dataSize;
    if (dataEnd > end) break;
    if (headerId === 0x0001) {
      const values = [];
      for (let p = dataStart; p + 8 <= dataEnd; p += 8) {
        values.push(readUint64Le(view, p));
      }
      return values;
    }
    cursor = dataEnd;
  }
  throw new Error("ZIP64 entry is missing required extended information.");
}

function findZip64CentralDirectory(view, eocdOffset) {
  const locatorOffset = eocdOffset - 20;
  if (locatorOffset < 0 || view.getUint32(locatorOffset, true) !== 0x07064b50) {
    throw new Error("ZIP64 locator was expected but not found.");
  }
  const zip64EocdOffset = Number(readUint64Le(view, locatorOffset + 8));
  if (view.getUint32(zip64EocdOffset, true) !== 0x06064b50) {
    throw new Error("ZIP64 end of central directory record is invalid.");
  }
  const totalEntries = Number(readUint64Le(view, zip64EocdOffset + 32));
  const centralOffset = Number(readUint64Le(view, zip64EocdOffset + 48));
  return { totalEntries, centralOffset };
}

function readUint64Le(view, offset) {
  const low = BigInt(view.getUint32(offset, true));
  const high = BigInt(view.getUint32(offset + 4, true));
  return low + (high << 32n);
}

function parseForwardingProfiles(extension) {
  return children(first(extension, "FwdProfiles"), "FwdProfile").map((profile) => {
    const available = first(profile, "AvailableRoute");
    const away = first(profile, "AwayRoute");
    const routes = [];

    for (const state of ["NoAnswer", "Busy", "NotRegistered"]) {
      const stateEl = first(available, state);
      if (stateEl) {
        routes.push({
          state,
          audience: "All calls",
          destination: parseDestinationElement(first(stateEl, "AllCalls")),
        });
        routes.push({
          state,
          audience: "Internal",
          destination: parseDestinationElement(first(stateEl, "Internal")),
        });
      }
    }

    for (const audience of ["Internal", "External"]) {
      const audienceEl = first(away, audience);
      if (audienceEl) {
        routes.push({
          state: "All hours",
          audience,
          destination: parseDestinationElement(first(audienceEl, "AllHours")),
        });
        routes.push({
          state: "Out of office hours",
          audience,
          destination: parseDestinationElement(first(audienceEl, "OutOfOfficeHours")),
        });
      }
    }

    return {
      name: text(profile, "Name"),
      noAnswerTimeout: text(profile, "NoAnswerTimeout"),
      ringMyMobile: /^true$/i.test(text(profile, "RingMyMobile")),
      disableRingGroupCalls: /^true$/i.test(text(profile, "DisableRingGroupCalls")),
      routes: routes.filter((route) => route.destination),
    };
  });
}

function parseForwardTypeDestination(el) {
  if (!el) return null;
  if (!hasStructuredDestination(el)) {
    return parseRouteString(text(el));
  }

  return destinationFromTypeAndDn(
    text(el, "ForwardType") || text(el, "To"),
    text(el, "ForwardDN") || first(el, "Internal")?.getAttribute("DN") || "",
    text(el, "External"),
  );
}

function hasStructuredDestination(el) {
  return ["ForwardType", "To", "ForwardDN", "Internal", "External"].some((tagName) => first(el, tagName));
}

function parseDestinationElement(el) {
  if (!el) return null;
  const kind = text(el, "To");
  if (!kind) return null;
  if (kind === "None") return { kind: "None", dn: "", external: "" };
  return {
    kind,
    dn: first(el, "Internal")?.getAttribute("DN") || "",
    external: text(el, "External"),
  };
}

function parseRouteString(raw) {
  if (!raw || raw.startsWith("ProceedWithNoExceptions")) return null;
  const [kind, dn = ""] = raw.split(".");
  return { kind, dn, external: "", raw };
}

function destinationFromTypeAndDn(kind, dn, external = "") {
  if (!kind) return null;
  if (kind === "None") return { kind: "None", dn: "", external: "" };
  return { kind, dn: dn || "", external: external || "" };
}

function firstWithFallback(el, tagNames) {
  for (const tagName of tagNames) {
    const match = first(el, tagName);
    if (match) return match;
  }
  return null;
}

function first(el, tagName) {
  return children(el, tagName)[0] || null;
}

function children(el, tagName) {
  if (!el) return [];
  return Array.from(el.children).filter((child) => !tagName || child.tagName === tagName);
}

function descendants(el, tagName) {
  if (!el) return [];
  return Array.from(el.getElementsByTagName(tagName));
}

function text(el, tagName) {
  const target = tagName ? first(el, tagName) : el;
  return target?.textContent?.trim() || "";
}

function parseWorkingHours(el) {
  const wh = first(el, "WorkingHours") || first(el, "OfficeHoursSchedule");
  if (!wh) return null;
  const type = wh.getAttribute("Type") || text(wh, "Type") || "";
  const scheduleName = wh.getAttribute("ScheduleName") || text(wh, "ScheduleName") || text(wh, "Name") || "";
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const schedule = {};
  for (const day of days) {
    // 3CX stores times either as child elements (<MonFrom>08:00</MonFrom>)
    // or as attributes on the WorkingHours element (MonFrom="08:00").
    const from = text(wh, `${day}From`) || wh.getAttribute(`${day}From`) || "";
    const to = text(wh, `${day}To`) || wh.getAttribute(`${day}To`) || "";
    if (from || to) schedule[day] = { from, to };
  }
  if (!type && !scheduleName && Object.keys(schedule).length === 0) return null;
  return { type, scheduleName, schedule };
}

function parseTenantOfficeHours(tenant) {
  const hoursEl = first(tenant, "Hours");
  if (!hoursEl) return null;
  const type = hoursEl.getAttribute("HoursType") || "";
  const ignoreHolidays = /^true$/i.test(hoursEl.getAttribute("IgnoreHolidays") || "");
  const schedule = {};
  for (const periods of children(hoursEl, "PeriodsOfDay")) {
    const day = periods.getAttribute("DayOfWeek") || "";
    const slots = children(periods, "PeriodOfDay").map((p) => ({
      begin: p.getAttribute("begin") || "",
      end: p.getAttribute("end") || "",
    })).filter((s) => s.begin || s.end);
    if (day && slots.length) schedule[day] = slots;
  }
  return { type, ignoreHolidays, schedule };
}
