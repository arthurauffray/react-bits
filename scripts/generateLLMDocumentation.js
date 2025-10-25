/* eslint-env node */
import fs from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_FILENAME = 'LLM-Documentation.txt';
const OUTPUT_DIR = path.join(process.cwd(), 'public');
const OUTPUT_PATH = path.join(OUTPUT_DIR, OUTPUT_FILENAME);
const REGISTRY_PATH = path.join(process.cwd(), 'registry.json');
const DEMO_DIR = path.join(process.cwd(), 'src/demo');
const CODE_CONSTANTS_DIR = path.join(process.cwd(), 'src/constants/code');

const CATEGORY_SLUGS = {
  TextAnimations: 'text-animations',
  Animations: 'animations',
  Components: 'components',
  Backgrounds: 'backgrounds'
};

const CATEGORY_ORDER = ['TextAnimations', 'Animations', 'Components', 'Backgrounds'];

function readRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    console.error('registry.json not found - run `npm run shadcn:generate` first.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

function pascalToKebab(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

function pascalToTitle(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2')
    .trim();
}

// Extract prop data from demo files
function extractPropsFromDemo(componentName, category) {
  const demoPath = path.join(DEMO_DIR, category, `${componentName}Demo.jsx`);
  if (!fs.existsSync(demoPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(demoPath, 'utf8');
    
    // Extract propData array - find the array with balanced braces
    const propDataStart = content.indexOf('const propData = [');
    if (propDataStart === -1) return null;
    
    // Find the closing bracket by counting braces
    let depth = 0;
    let inString = false;
    let stringChar = '';
    let propDataEnd = -1;
    
    for (let i = propDataStart + 17; i < content.length; i++) {
      const char = content[i];
      const prevChar = i > 0 ? content[i - 1] : '';
      
      // Handle strings
      if ((char === '"' || char === "'") && prevChar !== '\\') {
        if (!inString) {
          inString = true;
          stringChar = char;
        } else if (char === stringChar) {
          inString = false;
        }
      }
      
      if (!inString) {
        if (char === '[' || char === '{') depth++;
        if (char === ']' || char === '}') depth--;
        
        if (depth < 0) {
          propDataEnd = i;
          break;
        }
      }
    }
    
    if (propDataEnd === -1) return null;
    
    const propDataStr = content.substring(propDataStart + 18, propDataEnd);
    
    // Try to evaluate as JSON-like structure
    const props = [];
    
    // Split by prop objects more carefully
    const propObjects = [];
    let currentObj = '';
    depth = 0;
    inString = false;
    
    for (let i = 0; i < propDataStr.length; i++) {
      const char = propDataStr[i];
      const prevChar = i > 0 ? propDataStr[i - 1] : '';
      
      if ((char === '"' || char === "'") && prevChar !== '\\') {
        if (!inString) {
          inString = true;
          stringChar = char;
        } else if (char === stringChar) {
          inString = false;
        }
      }
      
      if (!inString) {
        if (char === '{') {
          if (depth === 0) currentObj = '';
          depth++;
        }
        if (char === '}') {
          depth--;
          if (depth === 0) {
            currentObj += char;
            propObjects.push(currentObj);
            currentObj = '';
            continue;
          }
        }
      }
      
      if (depth > 0) currentObj += char;
    }
    
    // Parse each prop object
    for (const objStr of propObjects) {
      try {
        const nameMatch = objStr.match(/name:\s*['"]([^'"]+)['"]/);
        const typeMatch = objStr.match(/type:\s*['"]([^'"]+)['"]/);
        
        // Match default more carefully - could be string, number, or object
        let defaultVal = '';
        const defaultStrMatch = objStr.match(/default:\s*['"]([\s\S]*?)['"]\s*,/);
        const defaultObjMatch = objStr.match(/default:\s*({[^}]*}|[^,\n]+)/);
        
        if (defaultStrMatch) {
          defaultVal = defaultStrMatch[1];
        } else if (defaultObjMatch) {
          defaultVal = defaultObjMatch[1].trim();
        }
        
        // Match description - handle multi-line
        const descMatch = objStr.match(/description:\s*['"]([^'"]*(?:''[^'"]*)*)['"]/);
        
        if (nameMatch) {
          props.push({
            name: nameMatch[1],
            type: typeMatch ? typeMatch[1] : 'unknown',
            default: defaultVal,
            description: descMatch ? descMatch[1] : ''
          });
        }
      } catch (e) {
        // Skip malformed props
      }
    }

    return props.length > 0 ? props : null;
  } catch (e) {
    return null;
  }
}

// Extract dependencies from code constants
function extractCodeInfo(componentName, category) {
  const categoryCodeDir = path.join(CODE_CONSTANTS_DIR, category);
  
  if (!fs.existsSync(categoryCodeDir)) {
    return { dependencies: [], usage: '' };
  }

  // Try to find the code file
  const files = fs.readdirSync(categoryCodeDir);
  const codeFile = files.find(f => 
    f.toLowerCase().includes(componentName.toLowerCase()) && f.endsWith('Code.js')
  );

  if (!codeFile) {
    return { dependencies: [], usage: '' };
  }

  try {
    const content = fs.readFileSync(path.join(categoryCodeDir, codeFile), 'utf8');
    
    // Extract dependencies
    const depsMatch = content.match(/dependencies:\s*['"]([^'"]+)['"]/);
    const dependencies = depsMatch ? depsMatch[1].split(/\s+/).filter(Boolean) : [];
    
    // Extract usage
    const usageMatch = content.match(/usage:\s*`([\s\S]*?)`/);
    const usage = usageMatch ? usageMatch[1].trim() : '';

    return { dependencies, usage };
  } catch (e) {
    return { dependencies: [], usage: '' };
  }
}

// Collect all component information
function collectComponentsDetailed(registry) {
  const categories = {};
  const knownCategories = new Set(Object.keys(CATEGORY_SLUGS));

  for (const item of registry.items || []) {
    if (!item.files?.length) continue;
    const primaryPath = item.files[0].path;
    const segments = primaryPath.split(/[\\/]/);

    const category = segments.find(s => knownCategories.has(s));
    if (!category) continue;
    
    const compName = item.title; // PascalCase
    
    if (!categories[category]) categories[category] = {};
    
    if (!categories[category][compName]) {
      // Get additional information
      const props = extractPropsFromDemo(compName, category);
      const codeInfo = extractCodeInfo(compName, category);
      
      // Get dependencies from registry
      const registryDeps = item.dependencies || [];
      const allDeps = [...new Set([...registryDeps, ...codeInfo.dependencies])];

      categories[category][compName] = {
        name: compName,
        description: item.description || '',
        props: props || [],
        dependencies: allDeps,
        usage: codeInfo.usage,
        variants: []
      };
    }
    
    // Track which variant this is
    const variant = item.name.split('-').slice(-2).join('-'); // e.g., "JS-CSS"
    if (!categories[category][compName].variants.includes(variant)) {
      categories[category][compName].variants.push(variant);
    }
  }
  
  return categories;
}

// Generate installation instructions
function generateInstallation(dependencies, componentName, variant = 'JS-CSS') {
  const lines = [];
  
  if (dependencies.length > 0) {
    lines.push('**Install dependencies:**');
    lines.push('```bash');
    lines.push(`npm install ${dependencies.join(' ')}`);
    lines.push('```');
    lines.push('');
  }
  
  lines.push('**Install component:**');
  lines.push('```bash');
  lines.push(`# Using shadcn`);
  lines.push(`npx shadcn@latest add https://reactbits.dev/r/${componentName}-${variant}`);
  lines.push('');
  lines.push(`# Using jsrepo`);
  const variantMap = {
    'JS-CSS': 'default',
    'JS-TW': 'tailwind',
    'TS-CSS': 'ts/default',
    'TS-TW': 'ts/tailwind'
  };
  const category = CATEGORY_ORDER.find(cat => 
    fs.existsSync(path.join(DEMO_DIR, cat, `${componentName}Demo.jsx`))
  ) || 'Components';
  const jsrepoVariant = variantMap[variant] || 'default';
  lines.push(`npx jsrepo add https://reactbits.dev/${jsrepoVariant}/${category}/${componentName}`);
  lines.push('```');
  
  return lines.join('\n');
}

// Format props table
function formatPropsTable(props) {
  if (!props || props.length === 0) return 'No props documented.';
  
  const lines = [];
  lines.push('| Prop | Type | Default | Description |');
  lines.push('|------|------|---------|-------------|');
  
  for (const prop of props) {
    const name = prop.name;
    const type = prop.type.replace(/\|/g, '\\|');
    const defaultVal = prop.default.replace(/\|/g, '\\|');
    const desc = prop.description.replace(/\|/g, '\\|');
    lines.push(`| ${name} | ${type} | ${defaultVal} | ${desc} |`);
  }
  
  return lines.join('\n');
}

// Build detailed component documentation
function buildDetailedComponentDocs(category, comps) {
  const slugBase = CATEGORY_SLUGS[category];
  const categoryTitle = pascalToTitle(category);
  
  const entries = Object.values(comps)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(c => {
      const kebab = pascalToKebab(c.name);
      const titleHuman = pascalToTitle(c.name);
      const url = `https://www.reactbits.dev/${slugBase}/${kebab}`;
      
      const sections = [];
      
      // Header
      sections.push(`### ${titleHuman}`);
      sections.push('');
      sections.push(`**URL:** ${url}`);
      sections.push(`**CLI:** \`${c.name}\``);
      sections.push('');
      
      // Description
      if (c.description) {
        sections.push(`**Description:** ${c.description}`);
        sections.push('');
      }
      
      // Dependencies
      sections.push('**Dependencies:**');
      if (c.dependencies.length > 0) {
        sections.push(`\`\`\`\n${c.dependencies.join(' ')}\n\`\`\``);
      } else {
        sections.push('None');
      }
      sections.push('');
      
      // Installation
      sections.push('**Installation:**');
      sections.push(generateInstallation(c.dependencies, c.name));
      sections.push('');
      
      // Props
      sections.push('**Props:**');
      sections.push(formatPropsTable(c.props));
      sections.push('');
      
      // Usage
      if (c.usage) {
        sections.push('**Usage Example:**');
        sections.push('```jsx');
        sections.push(c.usage);
        sections.push('```');
        sections.push('');
      }
      
      // Available Variants
      if (c.variants.length > 0) {
        sections.push('**Available Variants:** ' + c.variants.join(', '));
        sections.push('');
      }
      
      sections.push('---');
      sections.push('');
      
      return sections.join('\n');
    });
  
  return `## ${categoryTitle}\n\n${entries.join('\n')}`;
}

// Build header documentation
function buildHeader() {
  return `# React Bits - Complete LLM Documentation

**Version:** 1.0  
**Generated:** ${new Date().toISOString()}  
**Repository:** https://github.com/arthurauffray/react-bits  
**Website:** https://www.reactbits.dev

## Overview

React Bits is an open source collection of memorable UI elements - Components, Animations, Backgrounds, and Text Animations - provided in four implementation variants:

- **JavaScript + CSS** (default)
- **JavaScript + Tailwind** (tailwind)
- **TypeScript + CSS** (ts/default)
- **TypeScript + Tailwind** (ts/tailwind)

Components are copy-friendly and installable via CLI (jsrepo or shadcn).

## Important Notes for LLMs

- Components are organized by semantics: UI Components, Animations, Backgrounds, Text Animations
- Each component has 4 variants. All variants are kept in sync when updated
- Dependencies vary by component (e.g., gsap, motion, three, ogl)
- Always check and install dependencies before usage
- Component page URLs use kebab-case paths (e.g., /text-animations/split-text)
- CLI component identifiers use PascalCase (e.g., SplitText)

---

## Introduction

**URL:** https://www.reactbits.dev/get-started/introduction

React Bits is an open-source collection of carefully designed UI components that aim to enhance your React web applications. This is not your typical component library - you won't find a set of generic buttons, inputs, or other common UI elements here.

These components are designed to help you stand out and make a statement visually by adding a touch of creativity to your projects.

### Mission

The goal of React Bits is simple - provide flexible, visually stunning and most importantly, free components that take web projects to the next level.

The project is committed to the following principles:

- **Free For All:** You own the code, and it's free to use in your projects
- **Prop-First Approach:** Easy customization through thoughtfully exposed props
- **Fully Modular:** Install strictly what you need, React Bits is not a dependency
- **Free Choice:** JS or TS, plain CSS or Tailwind, the code is all here

#### Free For All

Every component you choose to bring into your project is yours to modify or extend, because you get full visibility of the code, not just an import.

#### Prop-First Approach

Every component is designed to be flexible and customizable, with props that allow you to adjust the look and feel without having to always dive into the code.

#### Fully Modular

React Bits is not your classic NPM library, you install only the components you need by either copying the code or using the CLI, without pulling in a whole library.

#### Free Choice

Whether you prefer JavaScript or TypeScript, plain CSS or Tailwind, all variants are available for you to use as you see fit.

### Performance Recommendations

While we optimize components for the best experience, here are some tips to keep in mind:

- **Less Is More:** Using more than 2-3 components on a page is not advised - it can overload your page with animations
- **Mobile Optimization:** Consider disabling certain effects on mobile and replacing them with static placeholders
- **Test Thoroughly:** Always test on multiple devices before going live

---

## Installation

**URL:** https://www.reactbits.dev/get-started/installation

You can install components using two methods: manual copy or CLI commands.

### Method 1: Manual Installation

1. **Pick a component:** Preview components and find something you like, then head to the Code tab
2. **Install dependencies:** Components may use external libraries - copy and run the dependency installation command
3. **Copy the code:** Use the controls to switch between JS/TS and CSS/Tailwind variants
4. **Use the component:** Import and use the component in your project with the provided usage example

### Method 2: CLI Installation

React Bits supports two CLI installation methods: [shadcn](https://ui.shadcn.com/) and [jsrepo](https://jsrepo.dev/). Both fetch the same component source.

#### Using shadcn CLI

\`\`\`bash
npx shadcn@latest add https://reactbits.dev/r/<Component>-<LANG>-<STYLE>
\`\`\`

Where:
- \`<Component>\`: PascalCase component name (e.g., SplitText)
- \`<LANG>\`: JS or TS
- \`<STYLE>\`: CSS or TW

**Example:**
\`\`\`bash
npx shadcn@latest add https://reactbits.dev/r/SplitText-JS-CSS
\`\`\`

**Available Combinations:**
- \`JS-CSS\` - JavaScript + Plain CSS
- \`JS-TW\` - JavaScript + Tailwind
- \`TS-CSS\` - TypeScript + Plain CSS
- \`TS-TW\` - TypeScript + Tailwind

#### Using jsrepo CLI

\`\`\`bash
npx jsrepo add https://reactbits.dev/<variant>/<Category>/<Component>
\`\`\`

Where:
- \`<variant>\`: default | tailwind | ts/default | ts/tailwind
- \`<Category>\`: TextAnimations | Animations | Components | Backgrounds
- \`<Component>\`: PascalCase component name

**Example:**
\`\`\`bash
npx jsrepo add https://reactbits.dev/default/TextAnimations/SplitText
\`\`\`

**Available Variants:**
- \`default\` - JavaScript + Plain CSS
- \`tailwind\` - JavaScript + Tailwind
- \`ts/default\` - TypeScript + Plain CSS
- \`ts/tailwind\` - TypeScript + Tailwind

**Note:** You can use these commands with other package managers (pnpm, yarn, bun) by swapping the prefix (e.g., \`pnpm dlx\` or \`yarn\` instead of \`npx\`).

---

## Key Resources

- **Homepage:** https://www.reactbits.dev
- **Introduction:** https://www.reactbits.dev/get-started/introduction
- **Installation Guide:** https://www.reactbits.dev/get-started/installation
- **MCP Setup:** https://www.reactbits.dev/get-started/mcp
- **Contributing:** https://github.com/arthurauffray/react-bits/blob/main/CONTRIBUTING.md
- **License:** https://github.com/arthurauffray/react-bits/blob/main/LICENSE.md

## Key Dependencies

- **GSAP** (https://gsap.com/docs/v3/) - Animation engine used by many motion components
- **Motion/Framer** (https://www.framer.com/motion/) - Declarative motion primitives
- **three.js** (https://threejs.org/docs/) - 3D engine for backgrounds and visuals
- **ogl** (https://github.com/oframe/ogl) - Lightweight WebGL for shader-driven backgrounds

---

# Component Documentation

`;
}

// Main generation function
function generateDetailedMarkdown(categories) {
  const categorySections = CATEGORY_ORDER
    .filter(cat => categories[cat])
    .map(cat => buildDetailedComponentDocs(cat, categories[cat]));

  return [
    buildHeader(),
    ...categorySections
  ].join('\n');
}

function main() {
  console.log('Generating comprehensive LLM documentation...');
  
  const registry = readRegistry();
  const categories = collectComponentsDetailed(registry);
  
  // Count components
  let totalComponents = 0;
  for (const cat of Object.keys(categories)) {
    totalComponents += Object.keys(categories[cat]).length;
  }
  
  console.log(`Found ${totalComponents} components across ${Object.keys(categories).length} categories`);
  
  const md = generateDetailedMarkdown(categories);
  
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, md, 'utf8');
  
  console.log(`✅ Generated ${path.relative(process.cwd(), OUTPUT_PATH)}`);
  console.log(`   File size: ${(md.length / 1024).toFixed(2)} KB`);
  console.log(`   Total components: ${totalComponents}`);
}

main();
