export function forEachChild(node, fn) {
    let child = node.firstChild;
    while (child) {
        fn(child);
        child = child.nextSibling;
    }
}
export function walk(node, fn) {
    fn(node);
    forEachChild(node, (child) => { walk(child, fn); });
}
export function findFirstNodeByName(root, name) {
    let found = null;
    walk(root, (node) => {
        if (!found && node.type.name === name) {
            found = node;
        }
    });
    return found;
}
export function findFirstChildByName(node, name) {
    let child = node.firstChild;
    while (child) {
        if (child.type.name === name) {
            return child;
        }
        child = child.nextSibling;
    }
    return null;
}
export function firstNamedChild(node) {
    let child = node.firstChild;
    while (child) {
        if (!child.type.isAnonymous) {
            return child;
        }
        child = child.nextSibling;
    }
    return null;
}
