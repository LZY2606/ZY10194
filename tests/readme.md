antlr4-c3 unit tests
--------------------
This folder contains the source code and some support files of unit tests for the code completion core. There are 3 grammars from which parsers + lexer were generated. One grammar is a very simple expression grammar, another one (CPP14.g4) has been downloaded from the [ANTLR4 grammar directory](https://github.com/antlr/grammars-v4/blob/master/cpp/CPP14.g4) and the third one (Whitebox.g4) is a synthetic grammar for whitebox tests (epsilon rules, wildcards, predicates).

You can easily regenerate the parser and lexers by running:

```bash
npm run-script generate
```

from the root folder of the module. It requires the `antlr4ts` node module, which is installed when you run `npm install` first.
