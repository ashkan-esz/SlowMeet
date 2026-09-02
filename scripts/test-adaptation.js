const { chooseAdaptationLevel } = require("../web/js/adaptation-policy.js");

const transition = (level, poor, good) =>
  chooseAdaptationLevel(level, poor, good, 3);

if (transition(2, 2, 0).level !== 1) throw new Error("poor network should downgrade normal to slow");
if (transition(1, 2, 0).level !== 0) throw new Error("poor network should downgrade slow to very-slow");
if (transition(0, 2, 0).level !== 0) throw new Error("downgrade should stop at very-slow");
if (transition(0, 0, 5).level !== 1) throw new Error("good network should upgrade very-slow to slow");
if (transition(1, 0, 5).level !== 2) throw new Error("good network should upgrade slow to normal");
if (transition(2, 0, 5).level !== 2) throw new Error("upgrade should stop at normal");
if (transition(2, 1, 0).level !== 2) throw new Error("downgrade requires two samples");
if (transition(0, 0, 4).level !== 0) throw new Error("upgrade requires five samples");

console.log("Adaptation tests passed");
