// webos-service Message.sender contains the LS2-resolved application ID.
// Its wrapper already strips the WAM process suffix; do not guess suffixes.
export const isCompanionCaller=message=>message?.sender==='top.hrhome.nascinema';
